"""Static verifier. Resolves and type-checks every name, annotates the AST in
place for codegen, and rejects anything outside the v0 semantics: unknown
names, type mismatches, struct values escaping into expressions, writes to
config, rebinding state handles, and identifiers that would collide with the
generated Rust."""

from hssndsl.ast_nodes import (
    Action, Assign, Attr, BinOp, BoolLit, BoolOp, Compare, Ctor, EmitStmt,
    Exists, If, Index, IntLit, Name, NotOp, Program, Require, StrLit,
    TransferStmt,
)
from hssndsl.errors import DslError

SCALARS = {"int", "str", "bool", "address"}
U64_MAX = 2**64 - 1

RUST_KEYWORDS = {
    "as", "async", "await", "box", "break", "const", "continue", "crate",
    "dyn", "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self",
    "static", "struct", "super", "trait", "true", "type", "unsafe", "use",
    "where", "while", "yield",
}
# names the generated Rust already uses
RESERVED_IDENTS = RUST_KEYWORDS | {
    "deps", "env", "info", "msg", "config", "sender", "height", "value",
    "time", "storage", "key", "addr",
}
RESERVED_TYPE_NAMES = {
    "Config", "InstantiateMsg", "ExecuteMsg", "QueryMsg", "ContractError",
    "Response", "Addr", "Env", "MessageInfo", "DepsMut", "Deps",
}


def camel(snake: str) -> str:
    return "".join(part.title() for part in snake.split("_"))


class _Checker:
    def __init__(self, program: Program):
        self.program = program
        self.states = {s.name: s for s in program.states}
        self.config = {f.name: f for f in program.config}

    def fail(self, message: str, node) -> None:
        raise DslError(message, getattr(node, "line", 0))

    def check_ident(self, name: str, what: str, node) -> None:
        if name in RESERVED_IDENTS:
            self.fail(f"{what} name {name!r} is reserved", node)

    # --- program-level checks ---

    def run(self) -> None:
        p = self.program
        if p.name.lower() in RESERVED_IDENTS:
            raise DslError(f"contract name {p.name!r} is reserved", 1)

        seen = set()
        for f in p.config:
            self.check_ident(f.name, "config field", f)
            if f.name in seen:
                self.fail(f"duplicate config field {f.name!r}", f)
            seen.add(f.name)

        for s in p.states:
            if s.name in RESERVED_TYPE_NAMES:
                self.fail(f"state name {s.name!r} is reserved", s)
            if sum(1 for other in p.states if other.name == s.name) > 1:
                self.fail(f"duplicate state {s.name!r}", s)
            field_names = set()
            for f in s.fields:
                self.check_ident(f.name, "field", f)
                if f.name in field_names:
                    self.fail(f"duplicate field {f.name!r} in state {s.name}", f)
                field_names.add(f.name)
                if f.ty == "address" and f.default is not None:
                    self.fail("address fields cannot have defaults", f)
                if f.ty == "int" and f.default is not None and f.default > U64_MAX:
                    self.fail("default exceeds the int range (u64)", f)
            s.defaultable = all(f.default is not None for f in s.fields)

        camel_names = set()
        for a in p.actions:
            self.check_ident(a.name, "action", a)
            c = camel(a.name)
            if c in camel_names or c in self.states or c in RESERVED_TYPE_NAMES:
                self.fail(f"action name {a.name!r} collides with another declaration", a)
            camel_names.add(c)
            self.check_action(a)

    # --- actions ---

    def check_action(self, action: Action) -> None:
        # scope: name -> scalar type string, or ("bound", state_name)
        scope: dict[str, object] = {}
        seen_params = set()
        for param in action.params:
            self.check_ident(param.name, "parameter", param)
            if param.name in seen_params:
                self.fail(f"duplicate parameter {param.name!r}", param)
            seen_params.add(param.name)
            scope[param.name] = param.ty
        # codegen annotations
        action.bindings: dict[str, str] = {}          # bound local -> state name
        action.mutated_bindings: set[str] = set()     # bound locals written through
        action.reassigned_locals: set[str] = set()    # plain locals assigned twice
        action.params_set = seen_params
        self.check_body(action.body, scope, action)

    def check_body(self, body, scope, action) -> None:
        for stmt in body:
            if isinstance(stmt, Require):
                ty = self.type_expr(stmt.cond, scope, action)
                if ty != "bool":
                    self.fail(f"require() condition must be bool, got {ty}", stmt.cond)
            elif isinstance(stmt, If):
                for cond, branch in stmt.branches:
                    ty = self.type_expr(cond, scope, action)
                    if ty != "bool":
                        self.fail(f"if condition must be bool, got {ty}", cond)
                    self.check_body(branch, dict(scope), action)
                self.check_body(stmt.orelse, dict(scope), action)
            elif isinstance(stmt, TransferStmt):
                to_ty = self.type_expr(stmt.to, scope, action)
                if to_ty != "address":
                    self.fail(f"transfer() recipient must be an address, got {to_ty}",
                              stmt.to)
                amt_ty = self.type_expr(stmt.amount, scope, action)
                if amt_ty != "int":
                    self.fail(f"transfer() amount must be int, got {amt_ty}",
                              stmt.amount)
            elif isinstance(stmt, EmitStmt):
                ty = self.type_expr(stmt.value, scope, action)
                if ty != "str":
                    self.fail(f"emit() takes a str, got {ty}", stmt.value)
            elif isinstance(stmt, Assign):
                self.check_assign(stmt, scope, action)
            else:
                self.fail("unsupported statement", stmt)

    def check_assign(self, stmt: Assign, scope, action) -> None:
        target, value = stmt.target, stmt.value

        # Map[key] = Ctor(...)
        if isinstance(target, Index):
            state = self.check_state_access(target, scope, action)
            if stmt.op != "=":
                self.fail("state entries only support plain assignment", stmt)
            if not isinstance(value, Ctor):
                self.fail(
                    f"assigning a state entry requires a constructor, e.g. "
                    f"{state.name}(...)", value)
            self.check_ctor(value, state, scope, action)
            return

        # local = ... (binding or scalar)
        if isinstance(target, Name):
            self.check_ident(target.id, "variable", target)
            if target.id in ("sender", "height", "value", "time"):
                self.fail(f"cannot assign to builtin {target.id!r}", target)
            if target.id in action.params_set:
                self.fail("cannot reassign an action parameter", target)
            existing = scope.get(target.id)
            if isinstance(existing, tuple):
                self.fail(f"cannot rebind state handle {target.id!r}", target)

            if isinstance(value, Index) and stmt.op == "=":
                state = self.check_state_access(value, scope, action)
                if existing is not None:
                    self.fail(f"cannot rebind {target.id!r} to a state handle", target)
                scope[target.id] = ("bound", state.name)
                action.bindings[target.id] = state.name
                target.kind = "bound"
                target.binding_state = state.name
                return

            ty = self.type_expr(value, scope, action)
            if ty not in SCALARS:
                self.fail("only int, str, bool, and address values can be "
                          "stored in variables", value)
            if stmt.op in ("+=", "-="):
                if existing is None:
                    self.fail(f"unknown variable {target.id!r}", target)
                if existing != "int" or ty != "int":
                    self.fail("+= and -= require int operands", stmt)
                action.reassigned_locals.add(target.id)
            elif existing is not None:
                if existing != ty:
                    self.fail(
                        f"variable {target.id!r} is {existing}, cannot assign {ty}",
                        stmt)
                action.reassigned_locals.add(target.id)
            else:
                scope[target.id] = ty
            target.kind = "local"
            return

        # tile.field = ... or Map[key].field = ...
        if isinstance(target, Attr):
            field = self.field_of_attr_target(target, scope, action)
            ty = self.type_expr(value, scope, action)
            if stmt.op in ("+=", "-="):
                if field.ty != "int" or ty != "int":
                    self.fail("+= and -= require int operands", stmt)
            elif field.ty != ty:
                self.fail(
                    f"field {field.name!r} is {field.ty}, cannot assign {ty}", stmt)
            if isinstance(target.obj, Name):
                action.mutated_bindings.add(target.obj.id)
            return

        self.fail("invalid assignment target", stmt)

    def field_of_attr_target(self, target: Attr, scope, action):
        obj = target.obj
        if isinstance(obj, Name):
            if obj.id == "config":
                self.fail("config is read-only", target)
            binding = scope.get(obj.id)
            if not isinstance(binding, tuple):
                self.fail(f"{obj.id!r} is not a state handle", target)
            obj.kind = "bound"
            state = self.states[binding[1]]
        elif isinstance(obj, Index):
            state = self.check_state_access(obj, scope, action)
        else:
            self.fail("invalid assignment target", target)
        for f in state.fields:
            if f.name == target.attr:
                return f
        self.fail(f"state {state.name!r} has no field {target.attr!r}", target)

    def check_ctor(self, ctor: Ctor, state, scope, action) -> None:
        if ctor.struct != state.name:
            self.fail(f"expected {state.name}(...), got {ctor.struct}(...)", ctor)
        provided = {}
        for name, expr in ctor.kwargs:
            if name in provided:
                self.fail(f"duplicate field {name!r}", ctor)
            field = next((f for f in state.fields if f.name == name), None)
            if field is None:
                self.fail(f"state {state.name!r} has no field {name!r}", ctor)
            ty = self.type_expr(expr, scope, action)
            if ty != field.ty:
                self.fail(f"field {name!r} is {field.ty}, got {ty}", expr)
            provided[name] = expr
        for f in state.fields:
            if f.name not in provided and f.default is None:
                self.fail(f"missing required field {f.name!r}", ctor)
        ctor.ty = state.name

    def check_state_access(self, index: Index, scope, action):
        state = self.states.get(index.map_name)
        if state is None:
            self.fail(f"unknown state {index.map_name!r}", index)
        key_ty = self.type_expr(index.key, scope, action)
        if key_ty != state.key_ty:
            self.fail(
                f"state {state.name!r} is keyed by {state.key_ty}, got {key_ty}",
                index.key)
        index.ty = state.name
        return state

    # --- expressions ---

    def type_expr(self, expr, scope, action) -> str:
        ty = self._type_expr(expr, scope, action)
        expr.ty = ty
        return ty

    def _type_expr(self, expr, scope, action) -> str:
        if isinstance(expr, IntLit):
            if expr.value > U64_MAX:
                self.fail("integer literal exceeds the int range (u64)", expr)
            return "int"
        if isinstance(expr, StrLit):
            return "str"
        if isinstance(expr, BoolLit):
            return "bool"

        if isinstance(expr, Name):
            if expr.id == "sender":
                expr.kind = "sender"
                return "address"
            if expr.id == "height":
                expr.kind = "height"
                return "int"
            if expr.id == "time":
                expr.kind = "time"
                return "int"
            if expr.id == "value":
                expr.kind = "value"
                return "int"
            if expr.id == "config":
                self.fail("config fields are accessed as config.<field>", expr)
            entry = scope.get(expr.id)
            if entry is None:
                self.fail(f"unknown name {expr.id!r}", expr)
            if isinstance(entry, tuple):
                self.fail(
                    f"state handle {expr.id!r} cannot be used as a value "
                    f"(access its fields instead)", expr)
            expr.kind = "param" if expr.id in action.params_set else "local"
            return entry

        if isinstance(expr, Attr):
            obj = expr.obj
            if isinstance(obj, Name) and obj.id == "config":
                field = self.config.get(expr.attr)
                if field is None:
                    self.fail(f"config has no field {expr.attr!r}", expr)
                return field.ty
            if isinstance(obj, Name):
                binding = scope.get(obj.id)
                if isinstance(binding, tuple):
                    obj.kind = "bound"
                    state = self.states[binding[1]]
                else:
                    self.fail(f"{obj.id!r} has no attributes", expr)
            elif isinstance(obj, Index):
                state = self.check_state_access(obj, scope, action)
            else:
                self.fail("invalid attribute access", expr)
            field = next((f for f in state.fields if f.name == expr.attr), None)
            if field is None:
                self.fail(f"state {state.name!r} has no field {expr.attr!r}", expr)
            return field.ty

        if isinstance(expr, Index):
            self.fail("state entries cannot be used as values here "
                      "(bind one first: x = Map[key])", expr)

        if isinstance(expr, Exists):
            state = self.states.get(expr.map_name)
            if state is None:
                self.fail(f"unknown state {expr.map_name!r}", expr)
            key_ty = self.type_expr(expr.key, scope, action)
            if key_ty != state.key_ty:
                self.fail(
                    f"state {state.name!r} is keyed by {state.key_ty}, got {key_ty}",
                    expr.key)
            return "bool"

        if isinstance(expr, Ctor):
            self.fail("constructors can only be assigned into a state map, "
                      "e.g. Tile[id] = Tile(...)", expr)

        if isinstance(expr, BinOp):
            lt = self.type_expr(expr.left, scope, action)
            rt = self.type_expr(expr.right, scope, action)
            if lt != "int" or rt != "int":
                self.fail(f"arithmetic requires int operands, got {lt} and {rt}", expr)
            return "int"

        if isinstance(expr, Compare):
            lt = self.type_expr(expr.left, scope, action)
            rt = self.type_expr(expr.right, scope, action)
            if lt != rt:
                self.fail(f"cannot compare {lt} with {rt}", expr)
            if expr.op in ("<", "<=", ">", ">=") and lt != "int":
                self.fail(f"ordering comparisons require int, got {lt}", expr)
            if lt not in SCALARS:
                self.fail("state values cannot be compared directly", expr)
            return "bool"

        if isinstance(expr, BoolOp):
            for part in expr.parts:
                ty = self.type_expr(part, scope, action)
                if ty != "bool":
                    self.fail(f"'{expr.op}' requires bool operands, got {ty}", part)
            return "bool"

        if isinstance(expr, NotOp):
            ty = self.type_expr(expr.operand, scope, action)
            if ty != "bool":
                self.fail(f"'not' requires a bool operand, got {ty}", expr)
            return "bool"

        self.fail("unsupported expression", expr)


def check(program: Program) -> None:
    _Checker(program).run()
