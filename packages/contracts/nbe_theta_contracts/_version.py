"""Contract schema version.

Bumped ONLY when the wire shape of a durable payload changes in a way
that's not backward-compatible. Consumers reject payloads whose
schema_version doesn't match.

Follow semver:
  MAJOR: breaking change (renamed / removed / retyped field).
  MINOR: additive optional field.
  PATCH: doc-only change; no wire shape change.
"""

SCHEMA_VERSION = "1.0.0"
