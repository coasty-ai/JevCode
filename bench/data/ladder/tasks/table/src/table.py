"""Render rows of strings as a fixed-width text table."""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from .fmt import pad, pad_left


def column_widths(rows: Sequence[Sequence[str]]) -> List[int]:
    """Widest cell per column across all rows (ragged rows count as empty cells)."""
    widths: List[int] = []
    for row in rows:
        for i, cell in enumerate(row):
            if i == len(widths):
                widths.append(0)
            widths[i] = max(widths[i], len(cell))
    return widths


def render(
    rows: Sequence[Sequence[str]],
    header: Optional[Sequence[str]] = None,
    fill: str = " ",
    sep: str = " | ",
    right: Tuple[int, ...] = (),
) -> str:
    """Render `rows` (plus an optional `header` and rule line) as text.

    `fill` is the character used to pad every cell out to its column width;
    columns whose index is in `right` are right-aligned, all others left-aligned.
    """
    all_rows: List[Sequence[str]] = ([header] if header is not None else []) + list(rows)
    widths = column_widths(all_rows)
    lines: List[str] = []
    for index, row in enumerate(all_rows):
        cells: List[str] = []
        for i, width in enumerate(widths):
            cell = row[i] if i < len(row) else ""
            if i in right:
                cells.append(pad_left(cell, width, fill))
            else:
                cells.append(pad(cell, width))
        lines.append(sep.join(cells))
        if header is not None and index == 0:
            lines.append(sep.join("-" * width for width in widths))
    return "\n".join(lines)


def render_dicts(records: Sequence[dict], columns: Sequence[str], **kwargs) -> str:
    """Render a list of dicts using `columns` as both the header and the key order."""
    rows = [[str(record.get(col, "")) for col in columns] for record in records]
    return render(rows, header=list(columns), **kwargs)


def csv_line(cells: Sequence[str], delimiter: str = ",") -> str:
    """Join cells, quoting any that contain the delimiter, a quote or a newline."""
    out = []
    for cell in cells:
        if any(ch in cell for ch in (delimiter, '"', "\n")):
            cell = '"' + cell.replace('"', '""') + '"'
        out.append(cell)
    return delimiter.join(out)
