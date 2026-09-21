"""A layered settings store: defaults, then overrides, with typed getters."""

from __future__ import annotations

from typing import Dict, List, Optional


class Settings:
    def __init__(self, defaults: Optional[Dict[str, str]] = None) -> None:
        self._defaults: Dict[str, str] = dict(defaults or {})
        self._overrides: Dict[str, str] = {}

    def set(self, key: str, value: str) -> None:
        self._overrides[key] = value

    def raw(self, key: str) -> Optional[str]:
        """The override, else the default, else None."""
        if key in self._overrides:
            return self._overrides[key]
        return self._defaults.get(key)

    def get(self, key: str, default: str = "") -> str:
        """The stripped string value, or `default` (as given) when the key is unknown."""
        value = self.raw(key)
        if value is None:
            return default
        return value.strip()

    def get_int(self, key: str, default: int = 0) -> int:
        value = self.raw(key)
        if value is None:
            return default
        return int(value.strip())

    def get_bool(self, key: str, default: bool = False) -> bool:
        value = self.raw(key)
        if value is None:
            return default
        return value.strip().lower() in ("1", "true", "yes", "on")

    def keys(self) -> List[str]:
        return sorted(set(self._defaults) | set(self._overrides))
