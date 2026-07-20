/* Interrupt stub trampolines for x86_64.
 *
 * Each stub pushes a fake error code when the CPU does not, then the vector
 * number, then jumps to a common handler that saves GPRs and calls C.
 */

.macro ISR_NOERR vec
.global isr\vec
.type isr\vec, @function
isr\vec:
    pushq $0
    pushq $\vec
    jmp isr_common_stub
.endm

.macro ISR_ERR vec
.global isr\vec
.type isr\vec, @function
isr\vec:
    pushq $\vec
    jmp isr_common_stub
.endm

.macro IRQ_STUB irq, vec
.global irq\irq
.type irq\irq, @function
irq\irq:
    pushq $0
    pushq $\vec
    jmp isr_common_stub
.endm

.section .text
.code64

/* CPU exceptions 0-31 */
ISR_NOERR 0
ISR_NOERR 1
ISR_NOERR 2
ISR_NOERR 3
ISR_NOERR 4
ISR_NOERR 5
ISR_NOERR 6
ISR_NOERR 7
ISR_ERR   8
ISR_NOERR 9
ISR_ERR   10
ISR_ERR   11
ISR_ERR   12
ISR_ERR   13
ISR_ERR   14
ISR_NOERR 15
ISR_NOERR 16
ISR_ERR   17
ISR_NOERR 18
ISR_NOERR 19
ISR_NOERR 20
ISR_NOERR 21
ISR_NOERR 22
ISR_NOERR 23
ISR_NOERR 24
ISR_NOERR 25
ISR_NOERR 26
ISR_NOERR 27
ISR_NOERR 28
ISR_NOERR 29
ISR_ERR   30
ISR_NOERR 31

/* Hardware IRQs remapped to 32-47 */
IRQ_STUB 0,  32
IRQ_STUB 1,  33
IRQ_STUB 2,  34
IRQ_STUB 3,  35
IRQ_STUB 4,  36
IRQ_STUB 5,  37
IRQ_STUB 6,  38
IRQ_STUB 7,  39
IRQ_STUB 8,  40
IRQ_STUB 9,  41
IRQ_STUB 10, 42
IRQ_STUB 11, 43
IRQ_STUB 12, 44
IRQ_STUB 13, 45
IRQ_STUB 14, 46
IRQ_STUB 15, 47

.extern isr_dispatch

.global isr_common_stub
.type isr_common_stub, @function
isr_common_stub:
    /* Save general-purpose registers (matches struct interrupt_frame). */
    pushq %rax
    pushq %rbx
    pushq %rcx
    pushq %rdx
    pushq %rsi
    pushq %rdi
    pushq %rbp
    pushq %r8
    pushq %r9
    pushq %r10
    pushq %r11
    pushq %r12
    pushq %r13
    pushq %r14
    pushq %r15

    mov %rsp, %rdi          /* arg0: pointer to interrupt_frame */
    cld
    call isr_dispatch

    popq %r15
    popq %r14
    popq %r13
    popq %r12
    popq %r11
    popq %r10
    popq %r9
    popq %r8
    popq %rbp
    popq %rdi
    popq %rsi
    popq %rdx
    popq %rcx
    popq %rbx
    popq %rax

    add $16, %rsp           /* pop int_no + err_code */
    iretq

/* Table of stub addresses for idt_init. */
.section .rodata
.global isr_stub_table
.align 8
isr_stub_table:
    .quad isr0,  isr1,  isr2,  isr3,  isr4,  isr5,  isr6,  isr7
    .quad isr8,  isr9,  isr10, isr11, isr12, isr13, isr14, isr15
    .quad isr16, isr17, isr18, isr19, isr20, isr21, isr22, isr23
    .quad isr24, isr25, isr26, isr27, isr28, isr29, isr30, isr31
    .quad irq0,  irq1,  irq2,  irq3,  irq4,  irq5,  irq6,  irq7
    .quad irq8,  irq9,  irq10, irq11, irq12, irq13, irq14, irq15
