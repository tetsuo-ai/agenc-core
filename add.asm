section .text
global _add_two

_add_two:
    mov rax, rdi
    add rax, rsi
    ret
