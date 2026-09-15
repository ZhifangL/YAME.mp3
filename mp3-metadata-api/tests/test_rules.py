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
    substitute_backrefs,
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

def test_star_captures_and_backrefs():
    regex = glob_to_regex("* - *", anchored=True)
    match = regex.match("Artist - Title")
    assert match is not None
    assert substitute_backrefs("$2 by $1", match) == "Title by Artist"


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


def test_out_of_range_backref_is_left_literal():
    match = glob_to_regex("*").match("x")
    assert substitute_backrefs("[$9]", match) == "[$9]"


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


def test_replace_literal_and_backrefs():
    context = ctx(title="Artist - Title")
    changes = apply("REPLACE", {"field": "title", "find": "* - *", "replace": "$2 - $1"}, context)
    assert context.fields["title"] == "Title - Artist"
    assert changes == [{
        "field": "title", "label": "Title",
        "before": "Artist - Title", "after": "Title - Artist",
    }]


def test_replace_case_sensitivity():
    params = {"field": "title", "find": "live", "replace": "LIVE"}
    assert apply("REPLACE", {**params, "case_sensitive": False}, ctx(title="Live"))[0]["after"] == "LIVE"
    assert apply("REPLACE", {**params, "case_sensitive": True}, ctx(title="Live")) == []


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


def test_set_cover_without_an_image_removes_artwork():
    context = RuleContext(fields={"__cover_data__": "AAAA"}, filename="a.mp3", parent_dir="/m", path="/m/a.mp3")
    assert apply("SET COVER", {"image": None}, context)[0]["after"] == "remove"


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
