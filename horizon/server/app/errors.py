class ReadUnavailable(Exception):
    """Missing approved storage/audit integration, or an operational read failure."""


class PublicationNotFound(Exception):
    """No completed publication/member matches the selection."""
