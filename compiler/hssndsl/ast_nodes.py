"""AST node definitions. The parser builds these; the type checker annotates
them in place (every expression gets a .ty, names get a .kind)."""

from dataclasses import dataclass, field


# --- expressions ---

@dataclass
class Expr:
    line: int
    ty: str | None = field(default=None, init=False, compare=False)


@dataclass
class Name(Expr):
    id: str = ""
    # filled by typecheck: "param" | "local" | "bound" | "sender" | "height"
    kind: str | None = field(default=None, init=False, compare=False)


@dataclass
class IntLit(Expr):
    value: int = 0


@dataclass
class StrLit(Expr):
    value: str = ""


@dataclass
class BoolLit(Expr):
    value: bool = False


@dataclass
class BinOp(Expr):
    op: str = ""  # "+" | "-"
    left: Expr | None = None
    right: Expr | None = None


@dataclass
class Compare(Expr):
    op: str = ""  # "==" | "!=" | "<" | "<=" | ">" | ">="
    left: Expr | None = None
    right: Expr | None = None


@dataclass
class BoolOp(Expr):
    op: str = ""  # "and" | "or"
    parts: list[Expr] = field(default_factory=list)


@dataclass
class NotOp(Expr):
    operand: Expr | None = None


@dataclass
class Attr(Expr):
    obj: Expr | None = None
    attr: str = ""


@dataclass
class Index(Expr):
    """State-map access: MapName[key]."""
    map_name: str = ""
    key: Expr | None = None


@dataclass
class Ctor(Expr):
    """State-struct construction: Tile(owner=sender, ...)."""
    struct: str = ""
    kwargs: list[tuple[str, Expr]] = field(default_factory=list)


@dataclass
class Exists(Expr):
    """exists(MapName[key])"""
    map_name: str = ""
    key: Expr | None = None


# --- statements ---

@dataclass
class Stmt:
    line: int


@dataclass
class Require(Stmt):
    cond: Expr = None
    msg: str = "requirement failed"


@dataclass
class Assign(Stmt):
    target: Expr = None
    op: str = "="  # "=" | "+=" | "-="
    value: Expr = None


@dataclass
class If(Stmt):
    # (condition, body) pairs for if/elif; orelse for the final else
    branches: list[tuple[Expr, list[Stmt]]] = field(default_factory=list)
    orelse: list[Stmt] = field(default_factory=list)


# --- declarations ---

@dataclass
class FieldDef:
    name: str
    ty: str
    default: object  # None = required; otherwise the literal default value
    line: int


@dataclass
class StateDef:
    name: str
    key_ty: str  # "int" | "address"
    fields: list[FieldDef]
    line: int
    # filled by typecheck: True if every field has a default (missing reads
    # yield the default instance instead of an error)
    defaultable: bool = False


@dataclass
class Param:
    name: str
    ty: str
    line: int


@dataclass
class Action:
    name: str
    params: list[Param]
    body: list[Stmt]
    line: int


@dataclass
class Program:
    name: str
    config: list[FieldDef]
    states: list[StateDef]
    actions: list[Action]
