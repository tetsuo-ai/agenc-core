; Standalone x86_64 Linux NASM assembly function
; Creates TCP socket, connects to example.com:80, sends HTTP GET request
; Assemble with: nasm -f elf64 http_asm.asm && ld http_asm.o -o http_asm
; Run with: ./http_asm

section .data
    ; HTTP request template
    http_request:
        db "GET / HTTP/1.1", 0x0d, 0x0a
        db "Host: example.com", 0x0d, 0x0a
        db "Connection: close", 0x0d, 0x0a
        db "User-Agent: asm-http/1.0", 0x0d, 0x0a
        db 0x0d, 0x0a, 0        ; Double CRLF + null terminator
    http_request_len equ $ - http_request - 1  ; Exclude null terminator

    ; example.com IPv4 address (resolved: 93.184.216.34)
    server_ip: dq 0x1622D85D  ; 93.184.216.34 in little-endian

    ; Socket addresses
    sockaddr_in:
        dw 2          ; AF_INET = 2
        dw 0x5000     ; port 80 (80 << 8 | 0)
        dd 0x1622D85D ; 93.184.216.34
    sockaddr_len equ $ - sockaddr_in

section .bss
    sockfd resq 1
    bytes_sent resq 1

section .text
    global _start

_start:
    ; === 1. CREATE SOCKET ===
    ; socket(AF_INET, SOCK_STREAM, 0)
    mov rax, 41          ; syscall: socket
    mov rdi, 2           ; domain: AF_INET
    mov rsi, 1           ; type: SOCK_STREAM
    mov rdx, 0           ; protocol: 0 (default)
    syscall
    
    test rax, rax
    js error             ; Jump if socket creation failed
    mov [sockfd], rax    ; Save socket file descriptor

    ; === 2. CONNECT TO SERVER ===
    ; connect(sockfd, sockaddr_in, 16)
    mov rax, 42          ; syscall: connect
    mov rdi, [sockfd]
    mov rsi, sockaddr_in
    mov rdx, 16          ; sizeof(sockaddr_in)
    syscall
    
    test rax, rax
    js error             ; Jump if connect failed

    ; === 3. SEND HTTP REQUEST ===
    ; send(sockfd, http_request, http_request_len, 0)
    mov rax, 44          ; syscall: send
    mov rdi, [sockfd]
    mov rsi, http_request
    mov rdx, http_request_len
    mov r10, 0           ; flags
    syscall
    
    test rax, rax
    js error
    mov [bytes_sent], rax
    ; Note: We don't receive response in this minimal version

    ; === 4. CLEANUP ===
    ; close(sockfd)
    mov rax, 3           ; syscall: close
    mov rdi, [sockfd]
    syscall

    ; === 5. EXIT SUCCESS ===
    mov rax, 60          ; syscall: exit
    mov rdi, 0           ; status: 0 (success)
    syscall

error:
    mov rax, 60          ; syscall: exit
    mov rdi, 1           ; status: 1 (error)
    syscall

; Usage notes:
; - Connects to example.com:80 (93.184.216.34)
; - Sends minimal HTTP/1.1 GET request
; - Syscall numbers for x86_64 Linux:
;   * socket = 41
;   * connect = 42  
;   * send = 44
;   * close = 3
;   * exit = 60