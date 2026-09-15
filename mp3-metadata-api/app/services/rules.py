"""Rule engine: CLEAR, REPLACE, WRITE, APPEND, COPY FROM, PARSE FILENAME, CHANGE CASE.

Rules are declarative, self-describing classes registered in REGISTRY.
Adding a new rule type means subclassing Rule, implementing apply() and
registering it: the API exposes the registry to the UI, which renders rule
editors dynamically, so new rules need no frontend work.

Wildcard syntax: * matches any run of characters, ? matches exactly one.
In REPLACE the "find" pattern supports wildcards and the replacement
supports $1..$9 back-references to those captures.
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
    so $1..$9 back-references refer to wildcards in order of appearance.
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


def substitute_backrefs(template: str, match: "re.Match") -> str:
    """Expand $1..$9 back-references in template from a match's groups."""

    def repl(m: "re.Match") -> str:
        idx = int(m.group(1))
        try:
            return match.group(idx) or ""
        except IndexError:
            return m.group(0)

    return re.sub(r"\$(\d)", repl, template)


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
            self.filename = value or ""
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

    @classmethod
    def describe(cls, params: dict[str, Any]) -> str:
        return cls.label

    @staticmethod
    def _changed(key: str, before: str, after: str) -> Optional[dict]:
        if before == after:
            return None
        return {"field": key, "label": field_label(key), "before": before, "after": after}


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
        {"name": "field", "label": "In field", "kind": "field", "default": "comment"},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        if key not in RULE_FIELD_KEYS:
            return []
        before = ctx.get(key)
        ctx.set(key, "")
        change = self._changed(key, before, "")
        return [change] if change else []

    @classmethod
    def describe(cls, params):
        return "Clear " + field_label(params.get("field") or "")


class ReplaceRule(Rule):
    type = "REPLACE"
    label = "Replace"
    description = "Find text (with * / ? wildcards) and replace it."
    params = [
        {"name": "field", "label": "In field", "kind": "field", "default": "title"},
        {"name": "find", "label": "Find", "kind": "text", "placeholder": " - ",
         "help": "Use * for any characters, ? for a single character."},
        {"name": "replace", "label": "Replace with", "kind": "text", "placeholder": " – ",
         "help": "Use $1, $2, ... to insert the wildcard captures."},
        {"name": "case_sensitive", "label": "Case sensitive", "kind": "bool", "default": True},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        find = params.get("find")
        replace = params.get("replace") or ""
        if key not in RULE_FIELD_KEYS or find is None:
            return []
        before = ctx.get(key)
        regex = glob_to_regex(find, case_sensitive=bool(params.get("case_sensitive", True)), anchored=False)
        after = regex.sub(lambda m: substitute_backrefs(replace, m), before)
        ctx.set(key, after)
        change = self._changed(key, before, after)
        return [change] if change else []

    @classmethod
    def describe(cls, params):
        return 'Replace "' + str(params.get("find", "")) + '" with "' + str(params.get("replace", "")) + '" in ' + field_label(params.get("field") or "")


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
        before = ctx.get(key)
        ctx.set(key, value)
        change = self._changed(key, before, value)
        return [change] if change else []

    @classmethod
    def describe(cls, params):
        return 'Write "' + str(params.get("value", "")) + '" to ' + field_label(params.get("field") or "")


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
        before = ctx.get(key)
        after = before + sep + value
        ctx.set(key, after)
        change = self._changed(key, before, after)
        return [change] if change else []

    @classmethod
    def describe(cls, params):
        return 'Append "' + str(params.get("value", "")) + '" to ' + field_label(params.get("field") or "")


class CopyFromRule(Rule):
    type = "COPY FROM"
    label = "Copy From"
    description = "Copy the value of another field (or File Name) into this field."
    params = [
        {"name": "source", "label": "From field", "kind": "field", "default": "date"},
        {"name": "field", "label": "Into field", "kind": "field", "default": "album"},
    ]

    def apply(self, ctx, params):
        key = params.get("field") or ""
        source = params.get("source") or ""
        if key not in RULE_FIELD_KEYS or source not in RULE_FIELD_KEYS:
            return []
        before = ctx.get(key)
        value = ctx.get(source)
        ctx.set(key, value)
        change = self._changed(key, before, value)
        return [change] if change else []

    @classmethod
    def describe(cls, params):
        return "Copy " + field_label(params.get("source") or "") + " → " + field_label(params.get("field") or "")


class ParseFilenameRule(Rule):
    type = "PARSE FILENAME"
    label = "Parse Filename"
    description = "Fill in fields based on filename pattern"
    params = [
        {"name": "pattern", "label": "Pattern", "kind": "parse_pattern", "placeholder": "Artist - Title",
         "help": "Each * captures a chunk of the file name. Assign each capture to a field below."},
        {"name": "include_extension", "label": "Include extension", "kind": "bool", "default": False},
        # assignments is a dict {capture_index: field_key}, produced by the parse_pattern editor.
        {"name": "assignments", "label": "Assignments", "kind": "parse_assignments", "default": {}},
    ]

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
        changes: list[dict] = []
        for index_str, field_key in assignments.items():
            try:
                index = int(index_str)
            except (TypeError, ValueError):
                continue
            if field_key not in RULE_FIELD_KEYS:
                continue
            value = match.group(index) or ""
            before = ctx.get(field_key)
            ctx.set(field_key, value)
            change = self._changed(field_key, before, value)
            if change:
                changes.append(change)
        return changes

    @classmethod
    def describe(cls, params):
        pattern = str(params.get("pattern") or "")
        return 'Parse file name with "' + pattern + '"'


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
        # Legacy "remove" mode or an empty image: strip artwork.
        if mode == "remove" or not image_data:
            return _clear_cover_state(ctx)
        # No-op when the working state already holds exactly this image.
        if ctx.cover_state.get("data") == image_data:
            return []
        before = "artwork present" if ctx.cover_state.get("data") else "no artwork"
        ctx.cover_state = {"mime": mime, "data": image_data, "name": name}
        after = name or (mime.split("/")[-1] + " image")
        return [{"field": "__cover__", "label": "Cover Art", "before": before,
                 "after": after, "_mime": mime, "_data_base64": image_data}]

    @classmethod
    def describe(cls, params):
        mode = str(params.get("mode") or "set")
        if mode == "remove":
            return "Remove cover art"
        image = params.get("image")
        if isinstance(image, dict) and image.get("data_base64"):
            name = str(image.get("name") or "")
            if name:
                return "Set cover art (" + name + ")"
            return "Set cover art (" + str(image.get("mime") or "image").split("/")[-1] + ")"
        return "Set cover art"


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
        ctx.set(key, after)
        change = self._changed(key, before, after)
        return [change] if change else []

    @classmethod
    def describe(cls, params):
        mode = str(params.get("mode") or "title")
        return "Change " + field_label(params.get("field") or "") + " to " + mode


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

    @classmethod
    def describe(cls, params):
        return "Remove cover art"

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


def get_rule(type_name: str) -> Optional[type[Rule]]:
    return REGISTRY.get(type_name)


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
