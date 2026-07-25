"""Tokenizer + recursive-descent parser for the mordsl grammar.

Lexing rides on Python's stdlib `tokenize` module: the DSL's tokens are a
subset of Python's, which gives us indentation (INDENT/DEDENT), strings, and
numbers for free. Everything the grammar doesn't allow is rejected here —
loops, imports, defs, floats, and f-strings never make it past the parser.

Grammar (v0):

    file    : "contract" NAME ":" INDENT item+ DEDENT
    item    : config | state | action
    config  : "config" ":" INDENT (NAME ":" type)+ DEDENT
    state   : "state" NAME "[" type "]" ":" INDENT field+ DEDENT
    field   : NAME ":" type ("=" literal)?
    action  : "action" NAME "(" params? ")" ":" INDENT stmt+ DEDENT
    stmt    : require | if | transfer | emit | assign
    transfer: "transfer" "(" expr "," expr ")"
    emit    : "emit" "(" expr ")"
    require : "require" "(" expr ("," STRING)? ")"
    if      : "if" expr ":" suite ("elif" expr ":" suite)* ("else" ":" suite)?
    assign  : target ("=" | "+=" | "-=") expr
    expr    : or_expr with precedence or < and < not < compare < add/sub < postfix
"""

import ast as py_ast
import io
import re
import token as T
import tokenize

from mordecaidsl.ast_nodes import (
    Action, Assign, Attr, BinOp, BoolLit, BoolOp, Compare, Ctor, EmitStmt,
    Exists, FieldDef, If, Index, IntLit, Name, NotOp, Param, Program,
    Require, StateDef, Stmt, StrLit, TransferStmt,
)
from mordecaidsl.errors import DslError

SCALAR_TYPES = {"int", "str", "bool", "address"}
COMPARE_OPS = {"==", "!=", "<", "<=", ">", ">="}
INT_RE = re.compile(r"^[0-9]+$")


class _Parser:
    def __init__(self, source: str, filename: str):
        self.filename = filename
        try:
            raw = tokenize.generate_tokens(io.StringIO(source).readline)
            self.toks = [
                t for t in raw
                if t.type not in (T.COMMENT, T.NL)
            ]
        except (tokenize.TokenError, IndentationError, SyntaxError) as e:
            raise DslError(f"tokenize error: {e}", 0, filename)
        self.pos = 0

    # --- token helpers ---

    def peek(self) -> tokenize.TokenInfo:
        return self.toks[self.pos]

    def next(self) -> tokenize.TokenInfo:
        tok = self.toks[self.pos]
        self.pos += 1
        return tok

    def error(self, message: str, tok=None):
        tok = tok or self.peek()
        raise DslError(message, tok.start[0], self.filename)

    def expect(self, type_, string=None) -> tokenize.TokenInfo:
        tok = self.peek()
        if tok.type != type_ or (string is not None and tok.string != string):
            want = string or T.tok_name[type_]
            self.error(f"expected {want!r}, got {tok.string!r}")
        return self.next()

    def expect_name(self, keyword=None) -> tokenize.TokenInfo:
        tok = self.expect(T.NAME)
        if keyword is not None and tok.string != keyword:
            self.error(f"expected {keyword!r}, got {tok.string!r}", tok)
        return tok

    def at(self, type_, string=None) -> bool:
        tok = self.peek()
        return tok.type == type_ and (string is None or tok.string == string)

    def eat(self, type_, string=None) -> bool:
        if self.at(type_, string):
            self.next()
            return True
        return False

    def newline(self):
        self.expect(T.NEWLINE)

    def ident(self) -> tokenize.TokenInfo:
        tok = self.expect(T.NAME)
        if tok.string in ("if", "elif", "else", "and", "or", "not", "True",
                          "False", "contract", "config", "state", "action",
                          "require", "exists", "transfer", "emit"):
            self.error(f"{tok.string!r} is a reserved word", tok)
        return tok

    # --- declarations ---

    def parse_program(self) -> Program:
        self.expect_name("contract")
        name = self.ident().string
        self.expect(T.OP, ":")
        self.newline()
        self.expect(T.INDENT)

        config: list[FieldDef] = []
        states: list[StateDef] = []
        actions: list[Action] = []
        while not self.at(T.DEDENT):
            tok = self.peek()
            if self.at(T.NAME, "config"):
                if config:
                    self.error("only one config block allowed", tok)
                config = self.parse_config()
            elif self.at(T.NAME, "state"):
                states.append(self.parse_state())
            elif self.at(T.NAME, "action"):
                actions.append(self.parse_action())
            else:
                self.error(
                    f"expected 'config', 'state', or 'action', got {tok.string!r}")
        self.expect(T.DEDENT)
        self.expect(T.ENDMARKER)
        if not actions:
            raise DslError("contract has no actions", 1, self.filename)
        return Program(name=name, config=config, states=states, actions=actions)

    def parse_type(self) -> str:
        tok = self.expect(T.NAME)
        if tok.string not in SCALAR_TYPES:
            self.error(
                f"unknown type {tok.string!r} (allowed: int, str, bool, address)", tok)
        return tok.string

    def parse_config(self) -> list[FieldDef]:
        self.expect_name("config")
        self.expect(T.OP, ":")
        self.newline()
        self.expect(T.INDENT)
        fields = []
        while not self.at(T.DEDENT):
            name_tok = self.ident()
            self.expect(T.OP, ":")
            ty = self.parse_type()
            self.newline()
            fields.append(FieldDef(name_tok.string, ty, None, name_tok.start[0]))
        self.expect(T.DEDENT)
        return fields

    def parse_state(self) -> StateDef:
        start = self.expect_name("state")
        name = self.ident().string
        self.expect(T.OP, "[")
        key_ty = self.parse_type()
        if key_ty not in ("int", "address"):
            self.error("state keys must be int or address", start)
        self.expect(T.OP, "]")
        self.expect(T.OP, ":")
        self.newline()
        self.expect(T.INDENT)
        fields = []
        while not self.at(T.DEDENT):
            name_tok = self.ident()
            self.expect(T.OP, ":")
            ty = self.parse_type()
            default = None
            if self.eat(T.OP, "="):
                default = self.parse_literal(ty)
            self.newline()
            fields.append(
                FieldDef(name_tok.string, ty, default, name_tok.start[0]))
        self.expect(T.DEDENT)
        if not fields:
            self.error(f"state {name!r} has no fields", start)
        return StateDef(name, key_ty, fields, start.start[0])

    def parse_literal(self, expected_ty: str):
        tok = self.peek()
        if tok.type == T.NUMBER:
            self.next()
            if not INT_RE.match(tok.string):
                self.error("only integer literals are allowed (no floats)", tok)
            if expected_ty != "int":
                self.error(f"default does not match field type {expected_ty!r}", tok)
            return int(tok.string)
        if tok.type == T.STRING:
            self.next()
            if expected_ty != "str":
                self.error(f"default does not match field type {expected_ty!r}", tok)
            return self.string_value(tok)
        if tok.type == T.NAME and tok.string in ("True", "False"):
            self.next()
            if expected_ty != "bool":
                self.error(f"default does not match field type {expected_ty!r}", tok)
            return tok.string == "True"
        self.error("defaults must be literal int, str, or bool values "
                   "(address fields cannot have defaults)", tok)

    def string_value(self, tok) -> str:
        s = tok.string
        if s[0] not in "'\"":
            self.error("string prefixes (f, b, r, ...) are not allowed", tok)
        if s[:3] in ("'''", '"""'):
            self.error("triple-quoted strings are not allowed", tok)
        return py_ast.literal_eval(s)

    def parse_action(self) -> Action:
        start = self.expect_name("action")
        name = self.ident().string
        self.expect(T.OP, "(")
        params: list[Param] = []
        if not self.at(T.OP, ")"):
            while True:
                p_tok = self.ident()
                self.expect(T.OP, ":")
                ty = self.parse_type()
                params.append(Param(p_tok.string, ty, p_tok.start[0]))
                if not self.eat(T.OP, ","):
                    break
                if self.at(T.OP, ")"):
                    break  # trailing comma
        self.expect(T.OP, ")")
        self.expect(T.OP, ":")
        body = self.parse_suite()
        return Action(name, params, body, start.start[0])

    # --- statements ---

    def parse_suite(self) -> list[Stmt]:
        self.newline()
        self.expect(T.INDENT)
        stmts = []
        while not self.at(T.DEDENT):
            stmts.append(self.parse_stmt())
        self.expect(T.DEDENT)
        return stmts

    def parse_stmt(self) -> Stmt:
        tok = self.peek()
        if tok.type == T.NAME:
            if tok.string == "require":
                return self.parse_require()
            if tok.string == "if":
                return self.parse_if()
            if tok.string == "transfer":
                return self.parse_transfer()
            if tok.string == "emit":
                return self.parse_emit()
            if tok.string in ("while", "for", "def", "import", "from",
                              "return", "class", "lambda", "del", "pass"):
                self.error(f"{tok.string!r} is not allowed in the v0 language", tok)
        return self.parse_assign()

    def parse_require(self) -> Require:
        start = self.expect_name("require")
        self.expect(T.OP, "(")
        cond = self.parse_expr()
        msg = "requirement failed"
        if self.eat(T.OP, ","):
            msg_tok = self.expect(T.STRING)
            msg = self.string_value(msg_tok)
        self.expect(T.OP, ")")
        self.newline()
        return Require(line=start.start[0], cond=cond, msg=msg)

    def parse_transfer(self) -> TransferStmt:
        start = self.expect_name("transfer")
        self.expect(T.OP, "(")
        to = self.parse_expr()
        self.expect(T.OP, ",")
        amount = self.parse_expr()
        self.expect(T.OP, ")")
        self.newline()
        return TransferStmt(line=start.start[0], to=to, amount=amount)

    def parse_emit(self) -> EmitStmt:
        start = self.expect_name("emit")
        self.expect(T.OP, "(")
        value = self.parse_expr()
        self.expect(T.OP, ")")
        self.newline()
        return EmitStmt(line=start.start[0], value=value)

    def parse_if(self) -> If:
        start = self.expect_name("if")
        branches = []
        cond = self.parse_expr()
        self.expect(T.OP, ":")
        branches.append((cond, self.parse_suite()))
        orelse: list[Stmt] = []
        while self.at(T.NAME, "elif"):
            self.next()
            cond = self.parse_expr()
            self.expect(T.OP, ":")
            branches.append((cond, self.parse_suite()))
        if self.at(T.NAME, "else"):
            self.next()
            self.expect(T.OP, ":")
            orelse = self.parse_suite()
        return If(line=start.start[0], branches=branches, orelse=orelse)

    def parse_assign(self) -> Assign:
        start = self.peek()
        target = self.parse_expr()
        if not isinstance(target, (Name, Attr, Index)):
            self.error("invalid assignment target", start)
        op_tok = self.peek()
        if op_tok.type != T.OP or op_tok.string not in ("=", "+=", "-="):
            self.error(f"expected an assignment, got {op_tok.string!r}", op_tok)
        self.next()
        value = self.parse_expr()
        self.newline()
        return Assign(line=start.start[0], target=target,
                      op=op_tok.string, value=value)

    # --- expressions ---

    def parse_expr(self):
        return self.parse_or()

    def parse_or(self):
        left = self.parse_and()
        if not self.at(T.NAME, "or"):
            return left
        parts = [left]
        while self.eat(T.NAME, "or"):
            parts.append(self.parse_and())
        return BoolOp(line=parts[0].line, op="or", parts=parts)

    def parse_and(self):
        left = self.parse_not()
        if not self.at(T.NAME, "and"):
            return left
        parts = [left]
        while self.eat(T.NAME, "and"):
            parts.append(self.parse_not())
        return BoolOp(line=parts[0].line, op="and", parts=parts)

    def parse_not(self):
        if self.at(T.NAME, "not"):
            tok = self.next()
            return NotOp(line=tok.start[0], operand=self.parse_not())
        return self.parse_compare()

    def parse_compare(self):
        left = self.parse_arith()
        tok = self.peek()
        if tok.type == T.OP and tok.string in COMPARE_OPS:
            self.next()
            right = self.parse_arith()
            after = self.peek()
            if after.type == T.OP and after.string in COMPARE_OPS:
                self.error("chained comparisons are not allowed", after)
            return Compare(line=left.line, op=tok.string, left=left, right=right)
        return left

    def parse_arith(self):
        left = self.parse_postfix()
        while self.at(T.OP, "+") or self.at(T.OP, "-"):
            op_tok = self.next()
            right = self.parse_postfix()
            left = BinOp(line=left.line, op=op_tok.string, left=left, right=right)
        return left

    def parse_postfix(self):
        expr = self.parse_atom()
        while True:
            if self.eat(T.OP, "."):
                attr_tok = self.ident()
                expr = Attr(line=expr.line, obj=expr, attr=attr_tok.string)
            elif self.at(T.OP, "["):
                if not isinstance(expr, Name):
                    self.error("only state maps can be indexed")
                self.next()
                key = self.parse_expr()
                self.expect(T.OP, "]")
                expr = Index(line=expr.line, map_name=expr.id, key=key)
            else:
                return expr

    def parse_atom(self):
        tok = self.peek()
        if tok.type == T.NUMBER:
            self.next()
            if not INT_RE.match(tok.string):
                self.error("only integer literals are allowed (no floats)", tok)
            return IntLit(line=tok.start[0], value=int(tok.string))
        if tok.type == T.STRING:
            self.next()
            return StrLit(line=tok.start[0], value=self.string_value(tok))
        if tok.type == T.NAME:
            if tok.string in ("True", "False"):
                self.next()
                return BoolLit(line=tok.start[0], value=tok.string == "True")
            if tok.string == "exists":
                self.next()
                self.expect(T.OP, "(")
                inner = self.parse_postfix()
                if not isinstance(inner, Index):
                    self.error("exists() takes a state access, e.g. exists(Tile[id])", tok)
                self.expect(T.OP, ")")
                return Exists(line=tok.start[0], map_name=inner.map_name,
                              key=inner.key)
            if tok.string == "config":
                # valid only as config.<field>; the type checker enforces that
                self.next()
                return Name(line=tok.start[0], id="config")
            name_tok = self.ident()
            if self.at(T.OP, "("):
                return self.parse_ctor(name_tok)
            return Name(line=name_tok.start[0], id=name_tok.string)
        if self.eat(T.OP, "("):
            expr = self.parse_expr()
            self.expect(T.OP, ")")
            return expr
        self.error(f"unexpected {tok.string!r} in expression")

    def parse_ctor(self, name_tok) -> Ctor:
        self.expect(T.OP, "(")
        kwargs: list[tuple[str, object]] = []
        if not self.at(T.OP, ")"):
            while True:
                key_tok = self.ident()
                self.expect(T.OP, "=")
                kwargs.append((key_tok.string, self.parse_expr()))
                if not self.eat(T.OP, ","):
                    break
                if self.at(T.OP, ")"):
                    break  # trailing comma
        self.expect(T.OP, ")")
        return Ctor(line=name_tok.start[0], struct=name_tok.string, kwargs=kwargs)


def parse(source: str, filename: str = "<string>") -> Program:
    return _Parser(source, filename).parse_program()
