class DslError(Exception):
    """A compile error in DSL source, with a source location."""

    def __init__(self, message: str, line: int = 0, filename: str = "<string>"):
        self.message = message
        self.line = line
        self.filename = filename
        super().__init__(f"{filename}:{line}: {message}")
