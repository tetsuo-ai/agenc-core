"""Launch authority and cancellation. All transitions serialize with lease claim."""

from __future__ import annotations

import secrets
import time
from pathlib import Path
from typing import Any, Callable

from cgroups import Scope, cleanup_scopes
from leases import LeaseStore
from protocol import HostError, LEASE_ENV, bounded_identity, operation_index
from runtime_adapter import execution_spec
from task_bootstrap import encode_bootstrap


class Containment:
    def __init__(self, store: LeaseStore, launch_root: Path,
                 assert_generation: Callable[[str], dict[str, Any]],
                 release_launch_files: Callable[[str], None] = lambda _: None):
        self.store = store
        self.launch_root = launch_root
        self.assert_generation = assert_generation
        self.release_launch_files = release_launch_files

    def authorize(self, principal: int, owner: str, generation: str, revision: int) -> None:
        if not bounded_identity(owner):
            raise HostError("invalid_authority", "Missing bounded session owner")
        with self.store.lock:
            self.assert_generation(generation)
            current = self.store.db.execute("SELECT * FROM authorities WHERE principal=? AND owner=?",
                                            (principal, owner)).fetchone()
            if current is not None:
                if current["generation"] != generation or type(revision) is not int or revision < current["revision"]:
                    raise HostError("invalid_authority", "Session environment or authority cannot be replaced")
                if current["revision"] != revision:
                    rows = self.store.db.execute("SELECT id FROM operations WHERE principal=? AND owner=? "
                                                 "AND cleanup_proven=0 AND (detached=0 OR state='allocated')", (principal, owner)).fetchall()
                    for row in rows:
                        self.stop(row["id"], principal, owner)
            self.store.authorize(principal, owner, generation, revision)

    def allocate(self, *, generation: str, principal: int, owner: str, run_id: str,
                 call_id: str, attempt: int, authority_revision: int,
                 spec: dict[str, Any], detached: bool = False, index: int = 0) -> tuple[str, str]:
        index = operation_index(index)
        for value in (owner, run_id, call_id):
            if not bounded_identity(value):
                raise HostError("invalid_request", "Missing bounded execution identity")
        if (type(attempt) is not int or attempt < 1 or type(authority_revision) is not int or
                authority_revision < 0 or type(detached) is not bool):
            raise HostError("invalid_request", "Invalid attempt or authority revision")
        if spec != execution_spec(spec) or any(value.split("=", 1)[0] == LEASE_ENV for value in spec["env"]):
            raise HostError("invalid_process", "Allocation requires an exact admitted process specification")
        operation = secrets.token_hex(16)
        if detached:
            spec = {**spec, "detachedLogPath": "/tmp/agenc-detached-" + operation + ".log"}
        # Bound the native protocol before creating either scope or a Docker
        # exec. An unsupported launch must not cross physical dispatch.
        encode_bootstrap(spec)
        with self.store.lock:
            binding = self.assert_generation(generation)
            self.store.assert_authority(principal, owner, generation, authority_revision)
            command = Scope.create(Path(binding["cgroupPath"]), "agenc-" + operation)
            try:
                launch = Scope.create(self.launch_root, "launch-" + operation)
                try:
                    return self.store.allocate(
                        generation=generation, principal=principal, owner=owner, run_id=run_id,
                        call_id=call_id, attempt=attempt, authority_revision=authority_revision,
                        spec=spec, detached=detached, operation_id=operation, index=index,
                        scope={"command": str(command.path), "commandIdentity": command.identity,
                               "launch": str(launch.path), "launchIdentity": launch.identity,
                               "subgroup": "agenc-" + operation})
                except BaseException:
                    launch.path.rmdir()
                    raise
                finally:
                    launch.close()
            except BaseException:
                command.path.rmdir()
                raise
            finally:
                command.close()

    def claim(self, *, marker: str, container_id: str, spec: dict[str, Any], peer_pid: int) -> dict[str, Any]:
        with self.store.lock:
            # Do not accept a caller-supplied generation. Resolve the stored
            # immutable binding again before consuming its one-use capability.
            row = self.store.operation(marker.split(".", 1)[0])
            binding = self.assert_generation(row["generation"])
            if container_id != binding["containerId"]:
                raise HostError("invalid_lease", "Launch lease targets a different container")
            row = self.store.validate_claim(marker, binding["generation"], spec)
            command, launch = self._scopes(row)
            try:
                command.assert_current()
                launch.assert_current()
                # The adapter is blocked awaiting this response and cannot fork
                # runc until its host-owned launch fence is established.
                launch.attach(peer_pid)
                self.store.transition(row["id"], ("allocated",), "claimed", "lease_claimed",
                                      runtime_pid=peer_pid)
                return {"operationId": row["id"], "subgroup": row["scope"]["subgroup"],
                        "processSpec": row["spec"]}
            except BaseException as error:
                self.store.quarantine(row["generation"], str(error))
                raise
            finally:
                command.close()
                launch.close()

    def _scopes(self, row: dict[str, Any]) -> tuple[Scope, Scope]:
        scope = row["scope"]
        command = Scope(Path(scope["command"]), tuple(scope["commandIdentity"]))
        try:
            return command, Scope(Path(scope["launch"]), tuple(scope["launchIdentity"]))
        except BaseException:
            command.close()
            raise

    def stop(self, operation: str, principal: int, owner: str) -> dict[str, bool]:
        with self.store.lock:
            row = self.store.operation(operation, principal, owner)
            if row["cleanup_proven"]:
                self.release_launch_files(operation)
                return {"terminated": False, "cleanupProven": True}
            if row["state"] == "quarantined":
                raise HostError("cleanup_unproven", row["failure"] or "Cleanup remains unproven")
            # This durable state forbids any future lease claim even if the
            # runtime is delayed until after an initial empty-scope observation.
            self.store.transition(operation, ("allocated", "claimed", "running", "stopping"),
                                  "stopping", "cancellation_fenced")
            try:
                command, launch = self._scopes(row)
                try:
                    populated = cleanup_scopes(launch, command)
                    self.store.transition(operation, ("stopping",), "stopped", "cleanup_proven",
                                          cleanup_proven=1, residual_processes_terminated=int(
                                              populated and row["leader_exited"] and not row["detached"]))
                    self.release_launch_files(operation)
                finally:
                    command.close()
                    launch.close()
            except BaseException as error:
                self.store.transition(operation, ("stopping",), "quarantined", "cleanup_unproven",
                                      failure=str(error))
                self.store.quarantine(row["generation"], str(error))
                raise HostError("cleanup_unproven", str(error)) from error
            return {"terminated": True, "cleanupProven": True}

    def recover(self) -> None:
        """Recover evidence and close uncertain scopes; never reissue execution."""
        with self.store.lock:
            rows = self.store.db.execute("SELECT id,principal,owner,detached,state,generation FROM operations WHERE state IN "
                                         "('allocated','claimed','running','stopping')").fetchall()
        for row in rows:
            # A supervisor restart loses live I/O acknowledgements. Even proven
            # cleanup does not settle the controller's canonical effect outcome.
            try:
                if row["detached"] and row["state"] in ("claimed", "running"):
                    # Already launched services have environment lifetime. A
                    # supervisor restart may fence an unfinished runtime, but
                    # must not turn that into run-owned service termination.
                    with self.store.lock:
                        self.assert_generation(row["generation"])
                        command, launch = self._scopes(self.store.operation(row["id"]))
                        try:
                            launch.kill_and_wait(time.monotonic() + 10)
                            if command.populated():
                                self.store.transition(row["id"], (row["state"],), row["state"],
                                                      "detached_scope_reconnected")
                                continue
                        finally:
                            command.close()
                            launch.close()
                self.stop(row["id"], row["principal"], row["owner"])
            except (HostError, OSError) as error:
                self.store.quarantine(row["generation"], str(error))
                continue
