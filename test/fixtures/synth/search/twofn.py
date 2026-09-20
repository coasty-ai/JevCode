def wrap(text, cols):
    lines = []
    while len(text) > cols:
        end = text.rfind(' ', 0, cols + 1)
        if end == -1:
            end = cols
        line, text = text[:end], text[end:]
        lines.append(line)
    return lines


def gcd(a, b):
    if b == 0:
        return a
    return gcd(a % b, b)
