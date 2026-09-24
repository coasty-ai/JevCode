"""Greetings (synthetic ladder fixture: a missing None guard)."""


def greet(name):
    """'Hello, <name>!'; None or an empty name greets the world."""
    if not name or not name.strip():
        return "Hello, world!"
    return "Hello, " + name.strip() + "!"
