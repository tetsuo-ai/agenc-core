; =============================================================================
; LONG X86_64 NASM ASSEMBLY DEMO PROGRAM
; Author: AgenC Assistant
; Features: Multiple functions, loops, Fibonacci, number printing, string handling
; Build: nasm -f elf64 function.asm -o function.o && ld -o function function.o
; Run: ./function
; =============================================================================

section .data
    welcome     db  '=== LONG ASSEMBLY DEMO PROGRAM ===', 10
                db  'Multiple functions, loops, math and syscalls', 10, 0
    welcome_len equ $ - welcome

    msg_func    db  '[*] Calling my_function()...', 10, 0
    msg_func_len equ $ - msg_func

    msg_loop    db  '[*] Running loop_demo()...', 10, 0
    msg_loop_len equ $ - msg_loop

    msg_fib     db  '[*] Fibonacci sequence (first 15 numbers):', 10, 0
    msg_fib_len equ $ - msg_fib

    msg_done    db  10, '=== Program completed successfully ===', 10, 0
    msg_done_len equ $ - msg_done

    prefix_iter db  '  Iteration: ', 0
    prefix_iter_len equ $ - prefix_iter

    prefix_fib  db  '  Fib(', 0
    prefix_fib_len equ $ - prefix_fib

    suffix_fib  db  ') = ', 0
    suffix_fib_len equ $ - suffix_fib

    newline     db  10, 0
    newline_len equ 1

    ; Buffer for number to string conversion
    num_buffer  times 32 db 0

section .bss
    counter     resq 1
    temp        resq 1
    fib_a       resq 1
    fib_b       resq 1
    fib_n       resq 1

section .text
    global _start

_start:
    ; Print welcome banner
    call print_string_welcome

    ; Call first function
    mov rax, 1
    mov rdi, 1
    mov rsi, msg_func
    mov rdx, msg_func_len
    syscall

    call my_function

    ; Call loop demo
    mov rax, 1
    mov rdi, 1
    mov rsi, msg_loop
    mov rdx, msg_loop_len
    syscall

    call loop_demo

    ; Call Fibonacci demo
    mov rax, 1
    mov rdi, 1
    mov rsi, msg_fib
    mov rdx, msg_fib_len
    syscall

    call fib_demo

    ; Print completion message
    mov rax, 1
    mov rdi, 1
    mov rsi, msg_done
    mov rdx, msg_done_len
    syscall

    ; Exit
    mov rax, 60
    xor rdi, rdi
    syscall

; =============================================================================
; Main demonstration function
; =============================================================================
my_function:
    push rbp
    mov rbp, rsp

    mov qword [counter], 100

    mov rcx, 6                    ; Run 6 iterations
.loop:
    mov rax, qword [counter]
    add rax, 37
    mov qword [counter], rax

    call print_number

    mov rax, 1
    mov rdi, 1
    mov rsi, newline
    mov rdx, newline_len
    syscall

    dec rcx
    jnz .loop

    pop rbp
    ret

; =============================================================================
; Nested loop demonstration
; =============================================================================
loop_demo:
    push rbp
    mov rbp, rsp

    mov qword [counter], 0

    mov r8, 3                     ; Outer loop counter
.outer:
    mov r9, 0                     ; Inner loop counter

.inner:
    inc qword [counter]

    mov rax, 1
    mov rdi, 1
    mov rsi, prefix_iter
    mov rdx, prefix_iter_len
    syscall

    call print_number
    call print_newline

    inc r9
    cmp r9, 3
    jl .inner

    dec r8
    jnz .outer

    pop rbp
    ret

; =============================================================================
; Fibonacci sequence generator and printer
; =============================================================================
fib_demo:
    push rbp
    mov rbp, rsp

    mov qword [fib_a], 0
    mov qword [fib_b], 1
    mov qword [fib_n], 0

    mov rcx, 15                   ; Print first 15 Fibonacci numbers

.fib_loop:
    mov rax, qword [fib_a]
    mov qword [counter], rax
    call print_fib_number

    ; Calculate next fib
    mov rax, qword [fib_a]
    mov rbx, qword [fib_b]
    add rax, rbx
    mov qword [fib_a], rbx
    mov qword [fib_b], rax

    inc qword [fib_n]
    dec rcx
    jnz .fib_loop

    pop rbp
    ret

; =============================================================================
; Helper functions
; =============================================================================
print_newline:
    mov rax, 1
    mov rdi, 1
    mov rsi, newline
    mov rdx, newline_len
    syscall
    ret

print_string_welcome:
    mov rax, 1
    mov rdi, 1
    mov rsi, welcome
    mov rdx, welcome_len
    syscall
    ret

; Print number stored in [counter]
print_number:
    push rbp
    mov rbp, rsp
    push rax
    push rbx
    push rcx
    push rdx

    mov rax, qword [counter]
    call number_to_string

    mov rax, 1
    mov rdi, 1
    mov rsi, num_buffer
    mov rdx, 20
    syscall

    pop rdx
    pop rcx
    pop rbx
    pop rax
    pop rbp
    ret

; Print formatted Fibonacci number
print_fib_number:
    push rbp
    mov rbp, rsp

    ; Print "  Fib("
    mov rax, 1
    mov rdi, 1
    mov rsi, prefix_fib
    mov rdx, prefix_fib_len
    syscall

    ; Print n
    mov rax, qword [fib_n]
    mov qword [counter], rax
    call print_number

    ; Print ") = "
    mov rax, 1
    mov rdi, 1
    mov rsi, suffix_fib
    mov rdx, suffix_fib_len
    syscall

    ; Print actual fib number
    mov rax, qword [counter]          ; reuse last printed? No, fix:
    mov rax, qword [fib_a]
    mov qword [counter], rax
    call print_number

    call print_newline

    pop rbp
    ret

; Convert number in RAX to string in num_buffer
number_to_string:
    push rbx
    push rcx
    push rdx
    push rdi

    mov rdi, num_buffer + 30
    mov byte [rdi], 0
    mov rbx, 10

.convert:
    xor rdx, rdx
    div rbx
    add dl, '0'
    dec rdi
    mov [rdi], dl
    test rax, rax
    jnz .convert

    ; Move string to start of buffer
    mov rsi, rdi
    mov rdi, num_buffer
    mov rcx, 30
.copy:
    mov al, [rsi]
    mov [rdi], al
    inc rsi
    inc rdi
    dec rcx
    jnz .copy

    pop rdi
    pop rdx
    pop rcx
    pop rbx
    ret

; =============================================================================
; Extra utility function (bonus)
; =============================================================================
calculate_sum:
    push rbp
    mov rbp, rsp

    xor rax, rax
    mov rcx, 50
.sum_loop:
    add rax, rcx
    dec rcx
    jnz .sum_loop

    mov qword [counter], rax
    call print_number

    pop rbp
    ret