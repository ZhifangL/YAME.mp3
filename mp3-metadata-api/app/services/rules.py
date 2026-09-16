"""Rule engine: CLEAR, REPLACE, WRITE, APPEND, COPY FROM, PARSE FILENAME,
CHANGE CASE, SET COVER, REMOVE COVER.

Rules are declarative and self-describing: each class declares its parameter
schema, the API serves that schema from REGISTRY, and the UI renders the
editor from it, so a new rule type needs no frontend work.

The user-facing one-line summary of a rule ("Replace " - " with " – " in
Title") is built in the frontend from that same schema (see src/rules.ts);
this module deliberately holds no second copy of those strings.

Params may set "required": True. That flag is advisory -- the engine still
guards itself -- but it is what the UI reads to keep its commit button
disabled until the rule is complete.

Wildcard syntax: * matches any run of characters, ? matches exactly one.
REPLACE substitutes the replacement text literally (no capture references:
PARSE FILENAME is the tool for moving parts of a value between fields).
In PARSE FILENAME each * or ? in the pattern captures one group and the
user assigns capture groups to fields.
"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import Any, ClassVar, Optional

from app.fields import RULE_FIELD_KEYS, field_label


# ------------------------------------------------------------------ wildcards

_REGEX_SPECIALS = set(r"\^$.|+()[]{}<>")


def glob_to_regex(pattern: str, *, case_sensitive: bool = True, anchored: bool = True) -> "re.Pattern":
    """Translate a * / ? wildcard pattern into a compiled regex.

    Every * becomes a capturing group (.*) and every ? a capturing group (.),
    so PARSE FILENAME can address each wildcard by its group number.
    """
    out: list[str] = []
    for ch in pattern:
        if ch == "*":
            out.append("(.*)")
        elif ch == "?":
            out.append("(.)")
        elif ch in _REGEX_SPECIALS or ch in "\"'":
            out.append("\\" + ch)
        else:
            out.append(ch)
    body = "".join(out)
    if anchored:
        body = "^" + body + "$"
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(body, flags)


def count_captures(pattern: str) -> int:
    return pattern.count("*") + pattern.count("?")


# ------------------------------------------------------------------ context


class RuleContext:
    """Working set of field values for one file during a ruleset run."""

    def __init__(self, fields: dict[str, Any], filename: str, parent_dir: str, path: str):
        clean: dict[str, str] = {}
        for k, v in (fields or {}).items():
            if isinstance(v, str):
                clean[k] = v
            elif v is None:
                clean[k] = ""
            else:
                clean[k] = str(v)
        self.fields = clean
        self.filename = filename or ""
        self.parent_dir = parent_dir or ""
        self.path = path or ""
        # Cover art works like a field: rules mutate this state in order, so a
        # ruleset of [SET COVER, REMOVE COVER] ends with no artwork and the
        # reverse order ends with the image — the last rule always wins.
        self.cover_state: dict[str, Any] = {
            "mime": clean.get("__cover_mime__") or None,
            "data": clean.get("__cover_data__") or None,
            "name": "",
        }

    def get(self, key: str) -> str:
        if key == "filename":
            return self.filename
        if key == "stem":
            return self.filename.rsplit(".", 1)[0] if "." in self.filename else self.filename
        if key == "ext":
            return "." + self.filename.rsplit(".", 1)[1] if "." in self.filename else ""
        if key == "folder_name":
            return self.parent_dir.rstrip("/").rsplit("/", 1)[-1] if self.parent_dir else ""
        if key == "folder_path":
            return self.parent_dir
        return self.fields.get(key, "")

    def set(self, key: str, value: str) -> None:
        if key == "filename":
            # The file name must never be blank — an empty name is not a file.
            # Refusing here covers every route to it at once: CLEAR, a WRITE
            # with no value, a REPLACE that matched the whole name, or a
            # COPY FROM an empty source. The rule simply reports no change.
            if not (value or "").strip():
                return
            self.filename = value
            return
        if key in ("stem", "ext", "folder_name", "folder_path"):
            return  # read-only pseudo-fields
        self.fields[key] = value or ""


# ------------------------------------------------------------------ rules


class Rule(ABC):
    type: ClassVar[str] = ""
    label: ClassVar[str] = ""
    description: ClassVar[str] = ""
    # Registry spec: each entry is {name, label, kind, choices, default, placeholder, help}
    params: ClassVar[list[dict]] = []

    @abstractmethod
    def apply(self, ctx: RuleContext, params: dict[str, Any]) -> list[dict]:
        """Apply the rule to ctx in place.

        Returns a change record for every field whose value actually
        changed: {"field": key, "label": str, "before": str, "after": str}.
        """

    @staticmethod
    def _changed(key: str, before: str, after: str) -> Optional[dict]:
        if before == after:
            return None
        return {"field": key, "label": field_label(key), "before": before, "after": after}

    @staticmethod
    def _write(ctx, key: str, value: str) -> Optional[dict]:
        """Set a field and report the change that actually took effect.

        Reading the value back matters: the context refuses some writes — it
        will not blank the file name, and ignores the read-only pseudo-fields —
        and a rule must never claim a change it did not make.
        """
        before = ctx.get(key)
        ctx.set(key, value)
        return Rule._changed(key, before, ctx.get(key))


def _clear_cover_state(ctx) -> list[dict]:
    """Sequential removal of the working cover state (used by SET COVER's
    legacy remove mode and by the REMOVE COVER rule)."""
    if not ctx.cover_state.get("data"):
        return []
    ctx.cover_state = {"mime": None, "data": None, "name": ""}
    return [{"field": "__cover__", "label": "Cover Art",
             "before": "artwork present", "after": "remove"}]


class ClearRule(Rule):
    type = "CLEAR"
    label = "Clear"
    description = "Remove the value of a field."
    params = [
        # Clearing a file name is never meaningful, so it is not offered.
        {"name": "field", "label": "In field", "kind": "field", "default": "comment",
         "exclude": ["filename"]},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        if key not in RULE_FIELD_KEYS:
            return []
        change = self._write(ctx, key, "")
        return [change] if change else []


class ReplaceRule(Rule):
    type = "REPLACE"
    label = "Replace"
    description = "Find text (with * / ? wildcards) and replace it."
    params = [
        {"name": "field", "label": "In field", "kind": "field", "default": "title"},
        {"name": "find", "label": "Find", "kind": "text", "required": True,
         "placeholder": " - ", "help": "Use * for any characters, ? for a single character."},
        {"name": "replace", "label": "Replace with", "kind": "text", "placeholder": " – "},
        {"name": "case_sensitive", "label": "Case sensitive", "kind": "bool", "default": True},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        find = params.get("find") or ""
        replace = params.get("replace") or ""
        # An empty Find matches at every position, which would splice the
        # replacement between every character and shred the value. Treat an
        # incomplete rule as a no-op rather than a destructive edit.
        if key not in RULE_FIELD_KEYS or not find:
            return []
        before = ctx.get(key)
        regex = glob_to_regex(find, case_sensitive=bool(params.get("case_sensitive", True)), anchored=False)
        # A function replacement keeps the text literal: re.sub() would
        # otherwise interpret backslashes and \g<...> escapes inside it.
        after = regex.sub(lambda _match: replace, before)
        change = self._write(ctx, key, after)
        return [change] if change else []


class WriteRule(Rule):
    type = "WRITE"
    label = "Write"
    description = "Overwrite a field with a fixed value."
    params = [
        {"name": "field", "label": "In field", "kind": "field", "default": "title"},
        {"name": "value", "label": "Value", "kind": "text", "placeholder": "New value"},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        value = params.get("value") or ""
        if key not in RULE_FIELD_KEYS:
            return []
        change = self._write(ctx, key, value)
        return [change] if change else []


class AppendRule(Rule):
    type = "APPEND"
    label = "Append"
    description = "Add text to the end of a field's current value."
    params = [
        {"name": "field", "label": "In field", "kind": "field", "default": "title"},
        {"name": "value", "label": "Text to append", "kind": "text", "placeholder": " (Live)"},
        {"name": "separator", "label": "Separator", "kind": "separator", "default": ""},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        value = params.get("value") or ""
        sep = params.get("separator") or ""
        if key not in RULE_FIELD_KEYS:
            return []
        after = ctx.get(key) + sep + value
        change = self._write(ctx, key, after)
        return [change] if change else []


class CopyFromRule(Rule):
    type = "COPY FROM"
    label = "Copy From"
    description = "Copy the value of another field (or File Name) into this field."
    params = [
        # A source may be any field, including the read-only pseudo-fields.
        {"name": "source", "label": "From field", "kind": "field", "default": "date",
         "role": "source"},
        {"name": "field", "label": "Into field", "kind": "field", "default": "album"},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        source = params.get("source") or ""
        if key not in RULE_FIELD_KEYS or source not in RULE_FIELD_KEYS:
            return []
        value = ctx.get(source)
        change = self._write(ctx, key, value)
        return [change] if change else []


class ParseFilenameRule(Rule):
    type = "PARSE FILENAME"
    label = "Parse Filename"
    description = "Fill in fields based on filename pattern"
    params = [
        {"name": "pattern", "label": "Pattern", "kind": "parse_pattern", "required": True,
         "placeholder": "Artist - Title",
         "help": "Each * captures a chunk of the file name. Assign each capture to a field below."},
        {"name": "include_extension", "label": "Include extension", "kind": "bool", "default": False},
        # assignments is a dict {capture_index: field_key}, produced by the
        # parse_pattern editor. The name fields are excluded: parsing a file
        # name into the file name is circular.
        {"name": "assignments", "label": "Assignments", "kind": "parse_assignments",
         "required": True, "default": {}, "exclude": ["filename", "stem"]},
    ]

    #: Fields this rule must not write, taken from its own param schema so the
    #: engine and the UI cannot drift apart.
    def _excluded(self) -> set[str]:
        for param in self.params:
            if param.get("name") == "assignments":
                return set(param.get("exclude") or [])
        return set()

    def apply(self, ctx, params):
        pattern = params.get("pattern") or ""
        if not pattern:
            return []
        source = ctx.get("filename") if params.get("include_extension") else ctx.get("stem")
        regex = glob_to_regex(pattern, case_sensitive=True, anchored=True)
        match = regex.match(source)
        if match is None:
            return []
        assignments = params.get("assignments") or {}
        if not isinstance(assignments, dict):
            return []
        # Writing the file name from the file name is circular; a saved preset
        # that still carries such an assignment is ignored, not obeyed.
        excluded = self._excluded()
        total_groups = match.re.groups
        changes: list[dict] = []
        for index_str, field_key in assignments.items():
            try:
                index = int(index_str)
            except (TypeError, ValueError):
                continue
            # Stale assignments survive in a saved rule when the pattern is
            # shortened; asking for a group that no longer exists used to raise
            # IndexError and fail the whole request.
            if index < 1 or index > total_groups:
                continue
            if field_key not in RULE_FIELD_KEYS or field_key in excluded:
                continue
            change = self._write(ctx, field_key, match.group(index) or "")
            if change:
                changes.append(change)
        return changes


class SetCoverRule(Rule):
    """Set the same embedded cover art on every file (batch album art).

    Produces a special "__cover__" change record that the applier in
    audio_io turns into a cover write/removal - cover bytes never touch
    the text-field pipeline.
    """

    type = "SET COVER"
    label = "Set Cover Art"
    description = ""
    params = [
        {"name": "image", "label": "Cover image", "kind": "image",
         "help": "Pick an image file (PNG/JPEG)."},
    ]

    def apply(self, ctx, params):
        image = params.get("image")
        mode = str(params.get("mode") or "set")
        image_data = None
        mime = "image/jpeg"
        name = ""
        if isinstance(image, dict):
            image_data = image.get("data_base64") or ""
            mime = str(image.get("mime") or "image/jpeg")
            name = str(image.get("name") or "")
        # Only the explicit legacy "remove" mode clears artwork. A SET COVER
        # that is missing its image is incomplete, and an imported or
        # hand-edited preset must not be able to delete every cover in a batch.
        if mode == "remove":
            return _clear_cover_state(ctx)
        if not image_data:
            return []
        # No-op when the working state already holds exactly this image.
        if ctx.cover_state.get("data") == image_data:
            return []
        before = "artwork present" if ctx.cover_state.get("data") else "no artwork"
        ctx.cover_state = {"mime": mime, "data": image_data, "name": name}
        after = name or (mime.split("/")[-1] + " image")
        return [{"field": "__cover__", "label": "Cover Art", "before": before,
                 "after": after, "_mime": mime, "_data_base64": image_data}]


class ChangeCaseRule(Rule):
    type = "CHANGE CASE"
    label = "Change Case"
    description = ""
    params = [
        {"name": "field", "label": "In field", "kind": "field", "default": "title"},
        {"name": "mode", "label": "To", "kind": "choice", "default": "title",
         "choices": [
             {"key": "upper", "label": "UPPER CASE"},
             {"key": "lower", "label": "lower case"},
             {"key": "title", "label": "Title Case"},
             {"key": "sentence", "label": "Sentence case"},
         ]},
    ]

    _SMALL_WORDS = {"a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
                    "at", "by", "in", "of", "on", "to", "up", "via", "vs", "vs.",
                    "with", "de", "la", "le", "el", "da", "von", "van"}

    @staticmethod
    def _upper_first_letter(word: str) -> str:
        """Upper-case the first LETTER, wherever it sits — so '(audio)'
        becomes '(Audio)' and '5seconds' becomes '5Seconds'."""
        for i, ch in enumerate(word):
            if ch.isalpha():
                return word[:i] + ch.upper() + word[i + 1:].lower()
        return word  # no letters at all

    @classmethod
    def _title_case(cls, text: str) -> str:
        out: list[str] = []
        first = True
        for word in re.split(r"(\s+)", text):
            if not word.strip():
                out.append(word)
                continue
            low = word.lower()
            if low in cls._SMALL_WORDS and not first:
                out.append(low)
            elif word.isupper():
                out.append(word)
            else:
                out.append(cls._upper_first_letter(word))
            first = False
        return "".join(out)

    @classmethod
    def _sentence_case(cls, text: str) -> str:
        parts = re.split(r"([.!?]+\s*)", text)
        out: list[str] = []
        cap_next = True
        for part in parts:
            if not part:
                continue
            if re.fullmatch(r"[.!?]+\s*", part):
                out.append(part)
                cap_next = True
            elif cap_next:
                out.append(cls._upper_first_letter(part))
                cap_next = False
            else:
                out.append(part)
        return "".join(out)

    def apply(self, ctx, params):
        key = params.get("field") or ""
        mode = params.get("mode") or "title"
        if key not in RULE_FIELD_KEYS:
            return []
        before = ctx.get(key)
        if mode == "upper":
            after = before.upper()
        elif mode == "lower":
            after = before.lower()
        elif mode == "sentence":
            after = self._sentence_case(before)
        else:
            after = self._title_case(before)
        change = self._write(ctx, key, after)
        return [change] if change else []


REGISTRY: dict[str, type[Rule]] = {}


def register(cls: type[Rule]) -> type[Rule]:
    REGISTRY[cls.type] = cls
    return cls


class RemoveCoverRule(Rule):
    """Delete embedded artwork from every file (no parameters)."""

    type = "REMOVE COVER"
    label = "Remove Cover Art"
    description = ""
    params = []

    def apply(self, ctx, params):
        return _clear_cover_state(ctx)


# Registration order drives the order of the rule menu in the UI.
register(ClearRule)
register(ReplaceRule)
register(WriteRule)
register(AppendRule)
register(CopyFromRule)
register(ParseFilenameRule)
register(ChangeCaseRule)
register(SetCoverRule)
register(RemoveCoverRule)


def registry_specs() -> list[dict]:
    """Self-describing rule catalog for the UI (kept in definition order)."""
    return [
        {
            "type": cls.type,
            "label": cls.label,
            "description": cls.description,
            "params": [dict(p) for p in cls.params],
        }
        for cls in REGISTRY.values()
    ]


# ------------------------------------------------------------------ ruleset runner


def run_ruleset(ctx: RuleContext, rules: list[dict]) -> tuple[dict[str, str], list[dict]]:
    """Run a list of rule instances (each {type, params, enabled}) over ctx.

    Returns (final_field_values, all_change_records). Change records carry
    rule_type and rule_label so the UI can attribute each change.
    """
    changes: list[dict] = []
    for rule in rules or []:
        if rule.get("enabled") is False:
            continue
        cls = REGISTRY.get(rule.get("type") or "")
        if cls is None:
            continue
        rule_changes = cls().apply(ctx, rule.get("params") or {})
        for change in rule_changes:
            change["rule_type"] = cls.type
            change["rule_label"] = cls.label
        changes.extend(rule_changes)
    return ctx.fields, changes
