.text
.globl _qsort
.globl _partition
.align 2

// long partition(long* arr, long low, long high)
_partition:
    lsl     x9, x2, #3          // high * 8
    add     x9, x0, x9
    ldr     x10, [x9]           // pivot = arr[high]

    mov     x11, x1             // i = low - 1
    sub     x11, x11, #1

    mov     x12, x1             // j = low
    sub     x13, x2, #1         // high-1

.Lpart_loop:
    cmp     x12, x13
    b.gt    .Lpart_done

    lsl     x14, x12, #3
    add     x14, x0, x14
    ldr     x15, [x14]          // arr[j]

    cmp     x15, x10
    b.gt    .Lpart_next

    add     x11, x11, #1        // i++

    lsl     x16, x11, #3
    add     x16, x0, x16
    ldr     x17, [x16]          // arr[i]

    str     x15, [x16]          // swap arr[i] and arr[j]
    str     x17, [x14]

.Lpart_next:
    add     x12, x12, #1
    b       .Lpart_loop

.Lpart_done:
    add     x11, x11, #1        // i + 1

    lsl     x14, x11, #3
    add     x14, x0, x14
    ldr     x15, [x14]

    lsl     x16, x2, #3
    add     x16, x0, x16
    ldr     x17, [x16]

    str     x17, [x14]          // swap arr[i+1] and arr[high]
    str     x15, [x16]

    mov     x0, x11
    ret


// void qsort(long* arr, long low, long high)
_qsort:
    stp     x29, x30, [sp, #-16]!
    mov     x29, sp
    stp     x19, x20, [sp, #-16]!
    stp     x21, x22, [sp, #-16]!

    mov     x19, x0             // arr
    mov     x20, x1             // low
    mov     x21, x2             // high

    cmp     x20, x21
    b.ge    .Lqsort_end

    mov     x0, x19
    mov     x1, x20
    mov     x2, x21
    bl      _partition
    mov     x22, x0             // pi

    mov     x0, x19
    mov     x1, x20
    sub     x2, x22, #1
    bl      _qsort

    mov     x0, x19
    add     x1, x22, #1
    mov     x2, x21
    bl      _qsort

.Lqsort_end:
    ldp     x21, x22, [sp], #16
    ldp     x19, x20, [sp], #16
    ldp     x29, x30, [sp], #16
    ret
