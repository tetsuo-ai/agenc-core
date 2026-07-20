#ifndef KERNEL_GDT_H
#define KERNEL_GDT_H

#include "types.h"

/* Long-mode segment selectors (RPL = 0). */
#define KERNEL_CS 0x08
#define KERNEL_DS 0x10
#define USER_CS   0x18
#define USER_DS   0x20
#define KERNEL_TSS 0x28

void gdt_init(void);

#endif /* KERNEL_GDT_H */
