"""An inferred schema: named, typed columns that check and coerce rows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Sequence

from .cells import cast, is_blank
from .infer import column_is_nullable, column_type


@dataclass(frozen=True)
class Column:
    name: str
    kind: str
    nullable: bool


@dataclass(frozen=True)
class Schema:
    columns: List[Column]

    def names(self) -> List[str]:
        return [column.name for column in self.columns]

    def kinds(self) -> List[str]:
        return [column.kind for column in self.columns]


def infer_schema(header: Sequence[str], rows: Sequence[Sequence[str]]) -> Schema:
    columns: List[Column] = []
    for index, name in enumerate(header):
        values = [row[index] for row in rows if index < len(row)]
        columns.append(Column(name=name, kind=column_type(values), nullable=column_is_nullable(values)))
    return Schema(columns=columns)


def validate(schema: Schema, row: Sequence[str]) -> List[str]:
    """Every problem with `row` under `schema`, in column order; empty when it is clean.

    A row that does not have one cell per column is reported and nothing else is checked.
    """
    errors: List[str] = []
    if len(row) < len(schema.columns):
        errors.append("row of %d, want %d" % (len(row), len(schema.columns)))
        return errors
    for column, value in zip(schema.columns, row):
        if is_blank(value):
            if not column.nullable:
                errors.append("%s: blank" % column.name)
            continue
        if cast(column.kind, value) is None:
            errors.append("%s: not %s" % (column.name, column.kind))
    return errors


def coerce(schema: Schema, row: Sequence[str]) -> List[Any]:
    """The row's cells as their column's kind; a blank cell becomes None."""
    return [None if is_blank(value) else cast(column.kind, value) for column, value in zip(schema.columns, row)]
