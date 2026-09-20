"""Storage backends for the Once framework-neutral execution core."""

from .sqlite import SQLiteOperationStore

__all__ = ["SQLiteOperationStore"]
