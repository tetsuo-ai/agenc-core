/** Python 3.11 http.server output captured under the real Linux launcher. */
export const PYTHON_SERVER_SOCKET_DENIED = `Traceback (most recent call last):
  File "/usr/lib/python3.11/http/server.py", line 1256, in test
    with ServerClass(addr, HandlerClass) as httpd:
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.11/socketserver.py", line 452, in __init__
    self.socket = socket.socket(self.address_family,
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.11/socket.py", line 232, in __init__
    _socket.socket.__init__(self, family, type, proto, fileno)
PermissionError: [Errno 1] Operation not permitted`;

export const PYTHON_SERVER_BIND_DENIED = `Traceback (most recent call last):
  File "/usr/lib/python3.11/socketserver.py", line 472, in server_bind
    self.socket.bind(self.server_address)
PermissionError: [Errno 13] Permission denied`;
