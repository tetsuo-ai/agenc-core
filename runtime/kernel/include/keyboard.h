#ifndef KERNEL_KEYBOARD_H
#define KERNEL_KEYBOARD_H

#include "types.h"

struct interrupt_frame;

void keyboard_init(void);
void keyboard_handler(struct interrupt_frame *frame);
int  keyboard_getchar(void);   /* non-blocking; returns -1 if empty */
char keyboard_getchar_block(void);

#endif /* KERNEL_KEYBOARD_H */
