/* Multiboot2 + 32-bit entry -> long mode bootstrap for bare-metal x86_64 kernel.
 *
 * Loaded by GRUB (or any Multiboot2 loader) in 32-bit protected mode.
 * Sets up identity-mapped 2 MiB pages, enables PAE/long mode, loads a 64-bit
 * GDT, and jumps to kernel_main in higher-half-ready flat 64-bit mode.
 */

.set MULTIBOOT2_MAGIC,          0xE85250D6
.set MULTIBOOT2_ARCHITECTURE,   0          /* i386 */
.set MULTIBOOT2_HEADER_LENGTH,  multiboot_header_end - multiboot_header
.set MULTIBOOT2_CHECKSUM,       -(MULTIBOOT2_MAGIC + MULTIBOOT2_ARCHITECTURE + MULTIBOOT2_HEADER_LENGTH)

.set KERNEL_STACK_SIZE, 16384

/* -------------------------------------------------------------------------- */
/* Multiboot2 header (must be in first 32 KiB, 64-bit aligned)                */
/* -------------------------------------------------------------------------- */
.section .multiboot, "a"
.align 8
multiboot_header:
    .long MULTIBOOT2_MAGIC
    .long MULTIBOOT2_ARCHITECTURE
    .long MULTIBOOT2_HEADER_LENGTH
    .long MULTIBOOT2_CHECKSUM

    /* end tag */
    .align 8
    .word 0          /* type */
    .word 0          /* flags */
    .long 8          /* size */
multiboot_header_end:

/* -------------------------------------------------------------------------- */
/* 32-bit protected-mode entry                                                */
/* -------------------------------------------------------------------------- */
.section .text.boot, "ax"
.code32
.global _start
.type _start, @function
_start:
    cli
    /* GRUB leaves us in 32-bit protected mode with paging off.
     * eax = multiboot2 magic, ebx = info structure physical address.
     */
    mov $stack_top, %esp
    mov %ebx, multiboot_info_ptr
    mov %eax, multiboot_magic

    /* Clear direction flag for string ops. */
    cld

    /* -------------------------------------------------------------------
     * Build a minimal 4-level page table with identity map of low 1 GiB
     * using one huge 1 GiB PDPT entry (or 512 x 2 MiB PDE entries).
     * We use 2 MiB pages for broader CPU compatibility.
     *
     * Layout (physically in .bss.pages):
     *   pml4[0] -> pdpt
     *   pdpt[0] -> pd
     *   pd[0..511] -> 2 MiB pages covering 0 .. 1 GiB
     * ------------------------------------------------------------------- */
    /* zero page tables */
    mov $pml4, %edi
    xor %eax, %eax
    mov $(4096 * 3 / 4), %ecx   /* pml4 + pdpt + pd */
    rep stosl

    /* pml4[0] = pdpt | present | rw */
    mov $pdpt, %eax
    or  $0x03, %eax
    mov %eax, pml4

    /* pdpt[0] = pd | present | rw */
    mov $pd, %eax
    or  $0x03, %eax
    mov %eax, pdpt

    /* Fill PD with 512 identity-mapped 2 MiB pages. */
    mov $pd, %edi
    xor %eax, %eax
    or  $0x83, %eax             /* present | rw | page size (2 MiB) */
    mov $512, %ecx
1:
    mov %eax, (%edi)
    add $0x200000, %eax         /* next 2 MiB */
    add $8, %edi
    loop 1b

    /* Load CR3 with PML4 */
    mov $pml4, %eax
    mov %eax, %cr3

    /* Enable PAE (CR4.PAE = bit 5) */
    mov %cr4, %eax
    or  $(1 << 5), %eax
    mov %eax, %cr4

    /* Enable long mode via EFER.LME (MSR 0xC0000080, bit 8) */
    mov $0xC0000080, %ecx
    rdmsr
    or  $(1 << 8), %eax
    wrmsr

    /* Enable paging (CR0.PG = bit 31). This enters compatibility mode. */
    mov %cr0, %eax
    or  $(1 << 31), %eax
    mov %eax, %cr0

    /* Load 64-bit GDT and far-jump into 64-bit code segment. */
    lgdt gdt64_pointer
    ljmp $0x08, $long_mode_entry

/* Halt forever if something goes wrong before long mode. */
hang32:
    cli
    hlt
    jmp hang32

/* -------------------------------------------------------------------------- */
/* 64-bit long mode                                                           */
/* -------------------------------------------------------------------------- */
.code64
.global long_mode_entry
.type long_mode_entry, @function
long_mode_entry:
    /* Reload data segments with null selector (recommended in long mode). */
    mov $0x10, %ax
    mov %ax, %ds
    mov %ax, %es
    mov %ax, %ss
    mov %ax, %fs
    mov %ax, %gs

    /* Set up a fresh 64-bit stack. */
    mov $stack_top, %rsp
    xor %rbp, %rbp

    /* Pass Multiboot info to kernel_main(magic, info). */
    mov multiboot_magic, %edi
    mov multiboot_info_ptr, %esi
    /* zero-extend to 64-bit */
    mov %edi, %edi
    mov %esi, %esi

    call kernel_main

.global halt_forever
halt_forever:
    cli
1:
    hlt
    jmp 1b

/* -------------------------------------------------------------------------- */
/* Early GDT used only for the protected->long mode transition                */
/* (kernel later installs a fuller GDT via gdt_init)                          */
/* -------------------------------------------------------------------------- */
.section .rodata
.align 16
gdt64:
    .quad 0x0000000000000000          /* 0x00: null */
    .quad 0x00AF9A000000FFFF          /* 0x08: 64-bit code, ring 0 */
    .quad 0x00CF92000000FFFF          /* 0x10: data, ring 0 */
gdt64_end:

gdt64_pointer:
    .word gdt64_end - gdt64 - 1
    .quad gdt64

/* -------------------------------------------------------------------------- */
/* BSS: stack + page tables + multiboot stash                                 */
/* -------------------------------------------------------------------------- */
.section .bss
.align 16
stack_bottom:
    .skip KERNEL_STACK_SIZE
.global stack_top
stack_top:

.align 4096
pml4:
    .skip 4096
pdpt:
    .skip 4096
pd:
    .skip 4096

.align 8
multiboot_info_ptr:
    .long 0
multiboot_magic:
    .long 0
