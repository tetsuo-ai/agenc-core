"""Docker daemon API transport. No docker CLI or task executable runs here."""

from __future__ import annotations

import http.client
import socket
from typing import Any
from urllib.parse import quote

from protocol import HostError, decode_json, encode_json


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 30):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


class DockerAPI:
    def __init__(self, socket_path: str = "/var/run/docker.sock"):
        self.socket_path = socket_path

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        connection = UnixHTTPConnection(self.socket_path)
        try:
            body = None if payload is None else encode_json(payload)
            connection.request(method, path, body=body,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise HostError("docker_response_limit", "Docker metadata exceeds its bound")
            if not 200 <= response.status < 300:
                raise HostError("docker_failure", f"Docker API returned HTTP {response.status}")
            return None if not data else decode_json(data)
        finally:
            connection.close()

    def inspect(self, container: str) -> dict[str, Any]:
        return self.request("GET", f"/containers/{quote(container, safe='')}/json")

    def info(self) -> dict[str, Any]:
        return self.request("GET", "/info")
