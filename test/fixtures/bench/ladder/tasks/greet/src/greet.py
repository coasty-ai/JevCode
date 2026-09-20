"""Greetings (synthetic ladder fixture: a missing None guard)."""


def greet(name):
    """'Hello, <name>!'; None or an empty name greets the world."""
    return "Hello, " + name.strip() + "!"
