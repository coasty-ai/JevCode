from src.profiles import User, card, display_name, handle, initials, mask_email, short_bio


def test_display_name_prefers_nickname():
    assert display_name(User("ada", "Ada Lovelace", nickname="Countess")) == "Countess"


def test_display_name_blank_nickname_falls_back():
    assert display_name(User("ada", "Ada Lovelace", nickname="   ")) == "Ada Lovelace"


def test_display_name_without_nickname():
    assert display_name(User("ada", "Ada Lovelace", nickname=None)) == "Ada Lovelace"


def test_card_without_nickname():
    user = User("Ada", "Ada Lovelace", email="ada@example.org")
    assert card(user) == "Ada Lovelace (@ada)\na***@example.org"


def test_card_with_everything():
    user = User("ada", "Ada Lovelace", nickname="Countess", email="ada@example.org", bio="Maths.")
    assert card(user) == "Countess (@ada)\na***@example.org\nMaths."


def test_initials_and_handle():
    assert initials(User("ada", "Ada  King Lovelace")) == "AKL"
    assert handle(User("AdaL", "Ada Lovelace")) == "@adal"


def test_mask_email():
    assert mask_email("ada@example.org") == "a***@example.org"


def test_mask_email_missing_or_malformed():
    assert mask_email(None) == "(no email)"
    assert mask_email("not-an-address") == "(no email)"


def test_short_bio_none():
    assert short_bio(User("ada", "Ada Lovelace")) == ""


def test_short_bio_truncates_and_collapses_whitespace():
    user = User("ada", "Ada Lovelace", bio="First   programmer,\n analytical engine enthusiast")
    assert short_bio(user, 20) == "First programmer,..."
