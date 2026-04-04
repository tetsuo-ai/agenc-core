.text
.globl _bubble_sort
.align 2

// void bubble_sort(long* arr, long n)
_bubble_sort:
    cmp     x1, #1
    b.le    .Ldone

    mov     x9, x1              // x9 = n
    sub     x9, x9, #1          // outer loop runs n-1 times

.Louter:
    mov     x10, #0             // x10 = i = 0
    mov     x11, x9             // x11 = inner loop limit (n - i - 1)

.Linner:
    lsl     x12, x10, #3        // x12 = i * 8 (offset)
    add     x13, x0, x12        // address of arr[i]
    ldr     x14, [x13]          // arr[i]

    add     x15, x13, #8        // address of arr[i+1]
    ldr     x16, [x15]          // arr[i+1]

    cmp     x14, x16
    b.le    .Lno_swap

    // Swap
    str     x16, [x13]
    str     x14, [x15]

.Lno_swap:
    add     x10, x10, #1
    cmp     x10, x11
    b.lt    .Linner

    subs    x9, x9, #1
    b.gt    .Louter

.Ldone:
    ret
