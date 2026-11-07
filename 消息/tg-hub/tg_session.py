"""iOS-safe Telethon session: no SQLite handle/transaction survives a method.

Stock SQLiteSession batches writes until save()/disconnect(). A resident client
can therefore hold a file lock across network awaits, and iOS kills a suspended
process with 0xdead10cc. Keep the existing .session format and entity cache, but
commit (or roll back) and close at each outermost synchronous session operation.
Do not replace this with autocommit per SQL statement: set_dc/auth_key updates
use DELETE + INSERT and must remain atomic.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from functools import wraps

from telethon.sessions import SQLiteSession


def _scoped(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._db_scope():
            return method(self, *args, **kwargs)
    return wrapped


class IOSSQLiteSession(SQLiteSession):
    """All access stays on the owning Telegram loop, just like SQLiteSession."""

    def __init__(self, session_id=None):
        self._scope_depth = 0
        with self._db_scope():
            super().__init__(session_id)

    @contextmanager
    def _db_scope(self):
        self._scope_depth += 1
        outer = self._scope_depth == 1
        try:
            yield
            if outer and self._conn is not None:
                self._conn.commit()
        except BaseException:
            conn = getattr(self, "_conn", None)
            if outer and conn is not None:
                conn.rollback()
            raise
        finally:
            self._scope_depth -= 1
            conn = getattr(self, "_conn", None)
            if outer and conn is not None and self.filename != ":memory:":
                try:
                    conn.close()
                finally:
                    self._conn = None

    def _cursor(self):
        if self._conn is None:
            self._conn = sqlite3.connect(
                self.filename, timeout=1.0, check_same_thread=False
            )
        return self._conn.cursor()

    # Nested calls share a transaction. set_dc must not commit/close between
    # updating sessions and reading back the auth key. Construction/upgrades
    # similarly finish as a single operation.
    set_dc = _scoped(SQLiteSession.set_dc)
    _update_session_table = _scoped(SQLiteSession._update_session_table)
    _execute = _scoped(SQLiteSession._execute)
    get_update_states = _scoped(SQLiteSession.get_update_states)
    process_entities = _scoped(SQLiteSession.process_entities)
    get_entity_rows_by_username = _scoped(SQLiteSession.get_entity_rows_by_username)

    def save(self):
        # Base __init__ calls save() inside the outer schema transaction.
        if self._scope_depth == 0:
            with self._db_scope():
                pass

    def close(self):
        self.save()
