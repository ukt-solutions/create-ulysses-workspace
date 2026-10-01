#!/usr/bin/env python3
"""
bulk-fill-migration.py — migrate SVG fill/stroke attributes to class-based styling.

Replaces patterns like:
    fill={colors.primary}     →  className={cls.fill.primary}
    stroke={colors.surface}   →  className={cls.stroke.surface}

This script handles three known regression cases that arose when this
migration was first done by hand:

1. Duplicate className=
   Some elements already have a className attribute. The migration
   would add a second one. JSX silently keeps only the second
   (the original, now stale). We detect duplicates and merge them.

2. Missing cls import
   The script adds cls.* references but doesn't update the import
   line. Build fails with undefined `cls`. We add `cls` to any
   tokens import line that doesn't already have it.

3. Variable-bound fills
   The script only matches the literal pattern `fill={colors.X}`.
   Variable-bound fills like `fill={labelColor}`,
   `fill={fillByVariant[variant]}`, or ternary fills are left
   alone and reported for manual review.

Idempotent: running twice on already-migrated code produces no changes.

Usage:
    python3 bulk-fill-migration.py <directory> [--dry-run]

Output: JSON to stdout
    {
        "filesScanned": int,
        "filesModified": [...],
        "needsManualReview": [{file, line, snippet}],
        "regressions": [...]
    }
"""

import argparse
import json
import re
import sys
from pathlib import Path


# ---------- Patterns ----------

# Match `fill={colors.X}` or `stroke={colors.X}` where X is a simple identifier.
# This intentionally does NOT match `fill={colors[key]}`, ternaries, or variables.
LITERAL_FILL = re.compile(r"\bfill=\{colors\.([a-zA-Z][a-zA-Z0-9]*)\}")
LITERAL_STROKE = re.compile(r"\bstroke=\{colors\.([a-zA-Z][a-zA-Z0-9]*)\}")

# Match variable-bound or ternary fills/strokes — flagged for manual review
VARIABLE_FILL = re.compile(
    r"\b(fill|stroke)=\{(?!colors\.[a-zA-Z][a-zA-Z0-9]*\})([^}]+)\}"
)

# Match the tokens import line so we can ensure `cls` is included
TOKENS_IMPORT = re.compile(
    r"import\s*\{\s*([^}]+?)\s*\}\s*from\s*['\"]([^'\"]*tokens[^'\"]*)['\"]"
)


# ---------- Migration logic ----------


def migrate_content(content: str) -> tuple[str, dict]:
    """Apply the migration to a file's content. Returns (new_content, info)."""
    info = {
        "literal_fill_replacements": 0,
        "literal_stroke_replacements": 0,
        "variable_fills_found": [],
        "duplicate_classnames_merged": 0,
        "import_updated": False,
    }

    # Step 1: replace literal fill={colors.X} → className={cls.fill.X}
    def replace_fill(match):
        info["literal_fill_replacements"] += 1
        return f"className={{cls.fill.{match.group(1)}}}"

    def replace_stroke(match):
        info["literal_stroke_replacements"] += 1
        return f"className={{cls.stroke.{match.group(1)}}}"

    content = LITERAL_FILL.sub(replace_fill, content)
    content = LITERAL_STROKE.sub(replace_stroke, content)

    # Step 2: detect variable-bound fills/strokes for manual review
    for line_num, line in enumerate(content.split("\n"), start=1):
        for m in VARIABLE_FILL.finditer(line):
            info["variable_fills_found"].append(
                {"line": line_num, "snippet": line.strip()[:200]}
            )

    # Step 3: merge duplicate className= attributes on the same element
    content, dup_count = merge_duplicate_classnames(content)
    info["duplicate_classnames_merged"] = dup_count

    # Step 4: ensure `cls` is in the tokens import
    if "cls.fill" in content or "cls.stroke" in content:
        content, import_updated = ensure_cls_import(content)
        info["import_updated"] = import_updated

    return content, info


def merge_duplicate_classnames(content: str) -> tuple[str, int]:
    """
    Merge multiple className= attributes on the same JSX element.

    Walks the content character by character to find JSX opening tags,
    then merges any duplicate className= attributes inside them.
    """
    result = []
    i = 0
    merge_count = 0
    n = len(content)

    while i < n:
        # Look for the start of a JSX opening tag
        if content[i] == "<" and i + 1 < n and (content[i + 1].isalpha() or content[i + 1] == "_"):
            # Find the end of the tag (closing > or />, balancing braces)
            tag_start = i
            tag_end = find_tag_end(content, i)
            if tag_end is None:
                result.append(content[i])
                i += 1
                continue
            tag_text = content[tag_start:tag_end + 1]
            merged_tag, merged_here = merge_classnames_in_tag(tag_text)
            merge_count += merged_here
            result.append(merged_tag)
            i = tag_end + 1
        else:
            result.append(content[i])
            i += 1

    return "".join(result), merge_count


def find_tag_end(content: str, start: int) -> int | None:
    """Find the closing > of a JSX tag starting at `start`, balancing braces."""
    i = start
    n = len(content)
    brace_depth = 0
    in_string = None  # None, '"', or "'"
    while i < n:
        c = content[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == in_string:
                in_string = None
        elif c in ("'", '"'):
            in_string = c
        elif c == "{":
            brace_depth += 1
        elif c == "}":
            brace_depth -= 1
        elif c == ">" and brace_depth == 0:
            return i
        i += 1
    return None


def merge_classnames_in_tag(tag_text: str) -> tuple[str, int]:
    """
    If the tag has multiple className= attributes, merge them into one.
    Returns (new_tag, merge_count_added).
    """
    # Find all className={...} occurrences, balancing braces.
    matches = list(find_classname_attrs(tag_text))
    if len(matches) < 2:
        return tag_text, 0

    # Extract class names from each match (everything inside {...})
    class_values = []
    for start, end in matches:
        inside = tag_text[start:end + 1]
        # className={...} → ...
        value = inside[len("className=") + 1:-1]
        class_values.append(value)

    # Build the merged value: combine into a single template literal
    # if any value is dynamic, otherwise concatenate string literals
    if all(is_string_literal(v) for v in class_values):
        joined = " ".join(strip_quotes(v) for v in class_values)
        merged = f'className="{joined}"'
    else:
        # Use template literal to combine: `${a} ${b}`
        parts = [to_template_part(v) for v in class_values]
        merged = "className={`" + " ".join(parts) + "`}"

    # Replace: keep first slot, remove subsequent ones
    first_start, first_end = matches[0]
    new_tag = tag_text[:first_start] + merged + tag_text[first_end + 1:]
    # Walk backwards to remove the rest (positions are now stale, so re-find)
    # Easier: rebuild from scratch by re-running on the new text
    if len(matches) > 2:
        new_tag, _ = merge_classnames_in_tag(new_tag)

    # Remove any remaining duplicate className attribute
    second_attrs = list(find_classname_attrs(new_tag))
    while len(second_attrs) > 1:
        # Remove the second one
        s, e = second_attrs[1]
        # Also remove leading whitespace before it
        ws_start = s
        while ws_start > 0 and new_tag[ws_start - 1] in " \t":
            ws_start -= 1
        new_tag = new_tag[:ws_start] + new_tag[e + 1:]
        second_attrs = list(find_classname_attrs(new_tag))

    return new_tag, len(matches) - 1


def find_classname_attrs(tag_text: str):
    """Yield (start, end) for each className= attribute in a tag."""
    i = 0
    n = len(tag_text)
    while i < n:
        idx = tag_text.find("className=", i)
        if idx == -1:
            return
        # Make sure it's a real attribute (preceded by whitespace or <)
        if idx > 0 and tag_text[idx - 1] not in " \t\n<":
            i = idx + 1
            continue
        value_start = idx + len("className=")
        if value_start >= n:
            return
        end = find_attr_value_end(tag_text, value_start)
        if end is None:
            return
        yield (idx, end)
        i = end + 1


def find_attr_value_end(tag_text: str, start: int) -> int | None:
    """Find the end of an attribute value starting at `start`."""
    n = len(tag_text)
    if start >= n:
        return None
    c = tag_text[start]
    if c == '"' or c == "'":
        # String value
        i = start + 1
        while i < n:
            if tag_text[i] == "\\":
                i += 2
                continue
            if tag_text[i] == c:
                return i
            i += 1
        return None
    if c == "{":
        # Brace expression — balance
        depth = 1
        i = start + 1
        in_string = None
        while i < n:
            ch = tag_text[i]
            if in_string:
                if ch == "\\":
                    i += 2
                    continue
                if ch == in_string:
                    in_string = None
            elif ch in ("'", '"', "`"):
                in_string = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        return None
    return None


def is_string_literal(value: str) -> bool:
    """True if value is a string literal like "foo" or 'foo'."""
    v = value.strip()
    return (
        len(v) >= 2
        and v[0] == v[-1]
        and v[0] in ("'", '"')
    )


def strip_quotes(value: str) -> str:
    v = value.strip()
    return v[1:-1]


def to_template_part(value: str) -> str:
    """Convert an attribute value into a template literal interpolation."""
    v = value.strip()
    if is_string_literal(v):
        return strip_quotes(v)
    return "${" + v + "}"


def ensure_cls_import(content: str) -> tuple[str, bool]:
    """Ensure `cls` is imported from any tokens import line."""
    updated = False

    def replace_import(match):
        nonlocal updated
        names = [n.strip() for n in match.group(1).split(",")]
        if "cls" in names:
            return match.group(0)
        names.append("cls")
        updated = True
        return f"import {{ {', '.join(names)} }} from '{match.group(2)}'"

    new_content = TOKENS_IMPORT.sub(replace_import, content)
    return new_content, updated


# ---------- Walk and apply ----------


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="Directory containing chapter component files")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing")
    args = parser.parse_args()

    root = Path(args.directory)
    if not root.exists():
        print(f"Error: directory not found: {root}", file=sys.stderr)
        sys.exit(2)

    files_scanned = 0
    files_modified = []
    needs_manual_review = []

    for path in root.rglob("*.tsx"):
        files_scanned += 1
        try:
            original = path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"Warning: could not read {path}: {e}", file=sys.stderr)
            continue

        new_content, info = migrate_content(original)

        if info["variable_fills_found"]:
            for finding in info["variable_fills_found"]:
                needs_manual_review.append(
                    {
                        "file": str(path.relative_to(root)),
                        "line": finding["line"],
                        "snippet": finding["snippet"],
                    }
                )

        if new_content != original:
            files_modified.append(
                {
                    "file": str(path.relative_to(root)),
                    "literal_fill_replacements": info["literal_fill_replacements"],
                    "literal_stroke_replacements": info["literal_stroke_replacements"],
                    "duplicate_classnames_merged": info["duplicate_classnames_merged"],
                    "import_updated": info["import_updated"],
                }
            )
            if not args.dry_run:
                path.write_text(new_content, encoding="utf-8")

    result = {
        "filesScanned": files_scanned,
        "filesModified": files_modified,
        "needsManualReview": needs_manual_review,
        "summary": {
            "scanned": files_scanned,
            "modified": len(files_modified),
            "manualReviewCount": len(needs_manual_review),
            "dryRun": args.dry_run,
        },
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
