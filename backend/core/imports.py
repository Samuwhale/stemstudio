from enum import StrEnum


class DraftSourceType(StrEnum):
    youtube = "youtube"
    local = "local"


class DraftStatus(StrEnum):
    pending = "pending"
    confirmed = "confirmed"
    discarded = "discarded"


class DraftDuplicateAction(StrEnum):
    create_new = "create-new"
    reuse_existing = "reuse-existing"
    skip = "skip"
