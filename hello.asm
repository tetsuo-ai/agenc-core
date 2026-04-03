section .data
    msg     db      "Hello from Assembly!", 0xA
    len     equ     $ - msg

section .text
    global _main
_main:
    ; Syscall for write on macOS (x86_64)
    mov     rax, 0x2000004     ; write
    mov     rdi, 1              ; stdout
    lea     rsi, [rel msg]
    mov     rdx, len
    syscall

    ; Syscall for exit
    mov     rax, 0x2000001     ; exit
    xor     rdi, rdi
    syscall
