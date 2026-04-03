.text
.globl _fib
.align 2

_fib:
    cmp     x0, #1
    b.ls    .Lreturn        // if n <= 1, return n

    mov     x1, x0          // loop counter = n
    mov     x2, #0          // prev = 0
    mov     x3, #1          // curr = 1

.Lloop:
    add     x4, x2, x3      // next = prev + curr
    mov     x2, x3          // prev = curr
    mov     x3, x4          // curr = next
    subs    x1, x1, #1
    b.ne    .Lloop

    mov     x0, x2          // return fib(n)
.Lreturn:
    ret
