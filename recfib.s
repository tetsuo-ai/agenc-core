.text
.globl _fib_rec
.align 2

_fib_rec:
    cmp     x0, #1
    b.ls    .Lreturn

    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    stp     x19, x20, [sp, #-16]!

    mov     x19, x0

    sub     x0, x19, #1
    bl      _fib_rec
    mov     x20, x0

    sub     x0, x19, #2
    bl      _fib_rec
    add     x0, x0, x20

    ldp     x19, x20, [sp], #16
    ldp     x29, x30, [sp], #16
    ret

.Lreturn:
    ret
