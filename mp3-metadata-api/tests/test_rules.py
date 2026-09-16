"""Rules-engine tests: wildcards, every rule type, and ruleset composition."""
from __future__ import annotations

import pytest

from app.services.rules import (
    REGISTRY,
    ChangeCaseRule,
    RuleContext,
    count_captures,
    glob_to_regex,
    registry_specs,
    run_ruleset,
)


def ctx(**fields) -> RuleContext:
    return RuleContext(
        fields=dict(fields),
        filename="Artist - Title.mp3",
        parent_dir="/Music",
        path="/Music/Artist - Title.mp3",
    )


def apply(rule_type: str, params: dict, context: RuleContext | None = None) -> list[dict]:
    """Run one rule and return its change records."""
    context = context or ctx()
    return REGISTRY[rule_type]().apply(context, params)


# ------------------------------------------------------------------ wildcards

def test_star_captures_each_side_of_a_separator():
    match = glob_to_regex("* - *", anchored=True).match("Artist - Title")
    assert match is not None
    assert (match.group(1), match.group(2)) == ("Artist", "Title")


def test_question_mark_matches_exactly_one_character():
    assert glob_to_regex("a?c").match("abc")
    assert glob_to_regex("a?c").match("ac") is None


def test_literal_regex_characters_are_escaped():
    regex = glob_to_regex("(Live) [Remix] + more?", anchored=True)
    assert regex.match("(Live) [Remix] + moreX")
    assert regex.match("Live Remix  moreX") is None


def test_unanchored_pattern_matches_inside_text():
    regex = glob_to_regex(" - ", anchored=False)
    assert regex.sub(" – ", "A - B - C") == "A – B – C"


def test_case_insensitive_flag():
    assert glob_to_regex("live", case_sensitive=False).search("LIVE")
    assert glob_to_regex("live", case_sensitive=True).search("LIVE") is None


def test_dollar_is_an_ordinary_character():
    """REPLACE has no capture references, so $ is literal on both sides."""
    assert glob_to_regex("$5", anchored=True).match("$5")
    context = ctx(title="price $5")
    apply("REPLACE", {"field": "title", "find": "$5", "replace": "$6"}, context)
    assert context.fields["title"] == "price $6"


def test_count_captures():
    assert count_captures("* - * (?)*") == 4


# ------------------------------------------------------------------ registry

def test_every_registered_rule_is_self_describing():
    specs = registry_specs()
    assert {s["type"] for s in specs} == set(REGISTRY)
    for spec in specs:
        assert spec["label"], spec["type"]
        for param in spec["params"]:
            assert {"name", "label", "kind"} <= set(param), spec["type"]
            assert param["kind"] in {
                "field", "text", "choice", "bool", "separator",
                "image", "parse_pattern", "parse_assignments",
            }, (spec["type"], param)


# ------------------------------------------------------------------ rules

def test_clear_only_reports_a_real_change():
    assert apply("CLEAR", {"field": "comment"}, ctx(comment="hi"))[0]["after"] == ""
    assert apply("CLEAR", {"field": "comment"}, ctx(comment="")) == []


def test_clear_ignores_unknown_fields():
    assert apply("CLEAR", {"field": "not_a_field"}, ctx(comment="hi")) == []


def test_replace_substitutes_a_literal_string():
    context = ctx(title="Artist - Title")
    changes = apply("REPLACE", {"field": "title", "find": " - ", "replace": " – "}, context)
    assert context.fields["title"] == "Artist – Title"
    assert changes == [{
        "field": "title", "label": "Title",
        "before": "Artist - Title", "after": "Artist – Title",
    }]


def test_replace_wildcards_match_without_capture_references():
    """Wildcards still match; the replacement is used verbatim."""
    context = ctx(title="Song (Official Audio)")
    apply("REPLACE", {"field": "title", "find": " (*", "replace": ""}, context)
    assert context.fields["title"] == "Song"

    context = ctx(title="Artist - Title")
    apply("REPLACE", {"field": "title", "find": "* - *", "replace": "$2 - $1"}, context)
    assert context.fields["title"] == "$2 - $1"


def test_replace_keeps_backslashes_literal():
    """re.sub() would otherwise treat \\1 as a group reference."""
    context = ctx(comment="a")
    apply("REPLACE", {"field": "comment", "find": "a", "replace": r"\1\g<0>"}, context)
    assert context.fields["comment"] == r"\1\g<0>"


def test_replace_case_sensitivity():
    params = {"field": "title", "find": "live", "replace": "LIVE"}
    assert apply("REPLACE", {**params, "case_sensitive": False}, ctx(title="Live"))[0]["after"] == "LIVE"
    assert apply("REPLACE", {**params, "case_sensitive": True}, ctx(title="Live")) == []


def test_replace_with_an_empty_find_does_nothing():
    """Regression: an empty pattern matched at every position and spliced the
    replacement between every character."""
    context = ctx(title="Song")
    assert apply("REPLACE", {"field": "title", "find": "", "replace": "-"}, context) == []
    assert context.fields["title"] == "Song"

    # Also for a missing key entirely (older saved presets).
    assert apply("REPLACE", {"field": "title", "replace": "-"}, context) == []
    assert context.fields["title"] == "Song"


def test_replace_whitespace_only_find_is_still_a_pattern():
    context = ctx(title="A B")
    apply("REPLACE", {"field": "title", "find": " ", "replace": "_"}, context)
    assert context.fields["title"] == "A_B"


def test_replace_can_delete_a_match():
    context = ctx(title="Song (Official Audio)")
    apply("REPLACE", {"field": "title", "find": " (*", "replace": ""}, context)
    assert context.fields["title"] == "Song"


def test_write_overwrites_and_reports_previous_value():
    context = ctx(genre="pop")
    changes = apply("WRITE", {"field": "genre", "value": "Rock"}, context)
    assert context.fields["genre"] == "Rock"
    assert changes[0]["before"] == "pop"


def test_append_uses_the_separator():
    context = ctx(title="Song")
    apply("APPEND", {"field": "title", "value": "(Live)", "separator": " "}, context)
    assert context.fields["title"] == "Song (Live)"


def test_copy_from_reads_another_field():
    context = ctx(date="2019", album="CALM")
    apply("COPY FROM", {"source": "date", "field": "album"}, context)
    assert context.fields["album"] == "2019"


def test_copy_from_can_read_the_file_name():
    context = ctx(title="")
    apply("COPY FROM", {"source": "filename", "field": "title"}, context)
    assert context.fields["title"] == "Artist - Title.mp3"


def test_parse_filename_assigns_captures_without_the_extension():
    context = ctx(title="", artist="")
    changes = apply("PARSE FILENAME", {
        "pattern": "* - *",
        "include_extension": False,
        "assignments": {"1": "artist", "2": "title"},
    }, context)
    assert context.fields["artist"] == "Artist"
    assert context.fields["title"] == "Title"
    assert {c["field"] for c in changes} == {"artist", "title"}


def test_parse_filename_with_extension_and_multiple_captures():
    context = RuleContext(
        fields={}, filename="Artist - Title (Album).mp3", parent_dir="/Music", path="/Music/x.mp3",
    )
    apply("PARSE FILENAME", {
        "pattern": "* - * (*).*",
        "include_extension": True,
        "assignments": {"1": "artist", "2": "title", "3": "album"},
    }, context)
    assert (context.fields["artist"], context.fields["title"], context.fields["album"]) == (
        "Artist", "Title", "Album",
    )


def test_parse_filename_ignores_the_extension_by_default():
    context = RuleContext(
        fields={}, filename="Artist - Title.mp3", parent_dir="/Music", path="/Music/x.mp3",
    )
    apply("PARSE FILENAME", {"pattern": "* - *", "assignments": {"2": "title"}}, context)
    assert context.fields["title"] == "Title"


def test_parse_filename_no_match_changes_nothing():
    assert apply("PARSE FILENAME", {
        "pattern": "ZZZ*", "assignments": {"1": "artist"},
    }, ctx()) == []


def test_parse_filename_skips_unknown_target_fields():
    context = ctx(title="original")
    apply("PARSE FILENAME", {
        "pattern": "* - *", "assignments": {"1": "not_a_field", "2": "title"},
    }, context)
    assert context.fields["title"] == "Title"


@pytest.mark.parametrize(("mode", "before", "after"), [
    ("upper", "Hello World", "HELLO WORLD"),
    ("lower", "Hello World", "hello world"),
    ("title", "the rise and fall", "The Rise and Fall"),
    ("title", "5seconds of summer", "5Seconds of Summer"),
    ("title", "(audio) version", "(Audio) Version"),
    ("title", "keep ACRONYM intact", "Keep ACRONYM Intact"),
    ("sentence", "hello world. second one! third?", "Hello world. Second one! Third?"),
])
def test_change_case_modes(mode, before, after):
    context = ctx(title=before)
    apply("CHANGE CASE", {"field": "title", "mode": mode}, context)
    assert context.fields["title"] == after


def test_change_case_is_a_no_op_when_already_correct():
    assert apply("CHANGE CASE", {"field": "title", "mode": "title"}, ctx(title="Title Case")) == []


def test_title_case_leaves_words_without_letters_alone():
    assert ChangeCaseRule._title_case("a - b") == "A - B"


def test_cover_rules_compose_in_order():
    image = {"mime": "image/png", "data_base64": "AAAA", "name": "art.png"}

    set_then_remove = ctx()
    apply("SET COVER", {"image": image}, set_then_remove)
    assert set_then_remove.cover_state["data"] == "AAAA"
    assert apply("REMOVE COVER", {}, set_then_remove)[0]["after"] == "remove"
    assert set_then_remove.cover_state["data"] is None

    remove_then_set = ctx()
    apply("REMOVE COVER", {}, remove_then_set)
    apply("SET COVER", {"image": image}, remove_then_set)
    assert remove_then_set.cover_state["data"] == "AAAA"


def test_set_cover_without_an_image_is_a_no_op():
    """An incomplete rule must not be able to strip artwork from a batch."""
    context = RuleContext(fields={"__cover_data__": "AAAA"}, filename="a.mp3", parent_dir="/m", path="/m/a.mp3")
    assert apply("SET COVER", {"image": None}, context) == []
    assert apply("SET COVER", {"image": {"mime": "image/png"}}, context) == []
    assert context.cover_state["data"] == "AAAA"


def test_set_cover_legacy_remove_mode_still_works():
    context = RuleContext(fields={"__cover_data__": "AAAA"}, filename="a.mp3", parent_dir="/m", path="/m/a.mp3")
    assert apply("SET COVER", {"image": None, "mode": "remove"}, context)[0]["after"] == "remove"


def test_parse_filename_ignores_stale_capture_indices():
    """Shortening the pattern leaves old assignments in a saved rule."""
    context = RuleContext(fields={"title": "T"}, filename="Plain.mp3", parent_dir="/m", path="/m/Plain.mp3")
    changes = apply("PARSE FILENAME", {
        "pattern": "*", "assignments": {"1": "title", "2": "artist", "9": "album"},
    }, context)
    # Capture 1 exists and is applied; the stale 2 and 9 are ignored rather
    # than raising IndexError and failing the request.
    assert [c["field"] for c in changes] == ["title"]
    assert context.fields["title"] == "Plain"
    assert context.fields.get("artist", "") == ""
    assert context.fields.get("album", "") == ""


def test_parse_filename_survives_a_malformed_assignments_value():
    context = ctx(title="T")
    assert apply("PARSE FILENAME", {"pattern": "* - *", "assignments": ["not", "a", "dict"]}, context) == []


def test_remove_cover_without_artwork_is_a_no_op():
    assert apply("REMOVE COVER", {}, ctx()) == []


# ------------------------------------------------------------------ rulesets

def test_run_ruleset_applies_in_order():
    context = ctx(title="Song")
    _, changes = run_ruleset(context, [
        {"type": "WRITE", "params": {"field": "title", "value": "First"}, "enabled": True},
        {"type": "APPEND", "params": {"field": "title", "value": " Second", "separator": ""}, "enabled": True},
    ])
    assert context.fields["title"] == "First Second"
    assert [c["after"] for c in changes] == ["First", "First Second"]
    assert all(c["rule_label"] for c in changes)


def test_run_ruleset_skips_disabled_and_unknown_rules():
    context = ctx(title="Song")
    run_ruleset(context, [
        {"type": "WRITE", "params": {"field": "title", "value": "Nope"}, "enabled": False},
        {"type": "NOT A RULE", "params": {}, "enabled": True},
    ])
    assert context.fields["title"] == "Song"


def test_rule_context_reads_pseudo_fields():
    context = RuleContext(
        fields={"title": "T"},
        filename="Artist - Title.flac",
        parent_dir="/Music/Albums",
        path="/Music/Albums/Artist - Title.flac",
    )
    assert context.get("stem") == "Artist - Title"
    assert context.get("ext") == ".flac"
    assert context.get("folder_name") == "Albums"
    assert context.get("folder_path") == "/Music/Albums"


def test_rule_context_write_to_filename_never_touches_fields():
    context = ctx(title="T")
    context.set("filename", "New.mp3")
    context.set("stem", "ignored")
    assert context.filename == "New.mp3"
    assert context.fields["title"] == "T"
    assert "stem" not in context.fields


def test_rule_context_coerces_non_string_values():
    context = RuleContext(fields={"bpm": 120, "comment": None}, filename="a.mp3", parent_dir="/m", path="/m/a.mp3")
    assert context.fields == {"bpm": "120", "comment": ""}


# --------------------------------------------------- the file name guard

def test_a_rule_can_never_blank_the_file_name():
    """An empty name is not a valid file, so every route to it is refused."""
    for rule_type, params in [
        ("CLEAR", {"field": "filename"}),
        ("WRITE", {"field": "filename", "value": ""}),
        ("WRITE", {"field": "filename", "value": "   "}),
        ("REPLACE", {"field": "filename", "find": "*", "replace": ""}),
        ("REPLACE", {"field": "filename", "find": "Artist - Title.mp3", "replace": ""}),
    ]:
        context = ctx()
        assert apply(rule_type, params, context) == [], (rule_type, params)
        assert context.filename == "Artist - Title.mp3", (rule_type, params)


def test_copy_from_an_empty_source_cannot_blank_the_file_name():
    context = ctx(comment="")
    assert apply("COPY FROM", {"source": "comment", "field": "filename"}, context) == []
    assert context.filename == "Artist - Title.mp3"


def test_parse_filename_cannot_assign_to_a_name_field():
    """Parsing the file name into the file name is circular, so the rule
    ignores such an assignment even if a saved preset still carries one."""
    for target in ("filename", "stem"):
        context = ctx()
        assert apply("PARSE FILENAME", {
            "pattern": "* - *", "assignments": {"1": target},
        }, context) == [], target
        assert context.filename == "Artist - Title.mp3", target

    # A real field in the same rule still applies.
    context = ctx(title="")
    apply("PARSE FILENAME", {
        "pattern": "* - *", "assignments": {"1": "filename", "2": "title"},
    }, context)
    assert context.filename == "Artist - Title.mp3"
    assert context.fields["title"] == "Title"


def test_renaming_through_the_file_name_field_still_works():
    """The guard blocks blanking, not renaming."""
    context = ctx(title="New Name")
    changes = apply("WRITE", {"field": "filename", "value": "New Name"}, context)
    assert context.filename == "New Name"
    assert [c["field"] for c in changes] == ["filename"]


def test_registry_marks_the_file_name_as_unblankable():
    from app.fields import RULE_FIELDS

    by_key = {f["key"]: f for f in RULE_FIELDS}
    assert by_key["filename"]["must_not_be_empty"] is True
    assert by_key["title"]["must_not_be_empty"] is False

    # CLEAR must not offer the file name, and PARSE FILENAME must not let a
    # capture be assigned to either name field.
    clear_field = next(p for p in REGISTRY["CLEAR"].params if p["name"] == "field")
    assert "filename" in clear_field["exclude"]

    assignments = next(p for p in REGISTRY["PARSE FILENAME"].params if p["name"] == "assignments")
    assert set(assignments["exclude"]) == {"filename", "stem"}

    # COPY FROM reads from any field, including the read-only pseudo-fields.
    source = next(p for p in REGISTRY["COPY FROM"].params if p["name"] == "source")
    assert source["role"] == "source"
