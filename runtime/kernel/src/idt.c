#include "idt.h"
#include "gdt.h"
#include "io.h"
#include "string.h"
#include "vga.h"

#define IDT_ENTRIES 256
#define PIC1_CMD    0x20
#define PIC1_DATA   0x21
#define PIC2_CMD    0xA0
#define PIC2_DATA   0xA1
#define PIC_EOI     0x20

struct idt_entry {
    uint16_t offset_low;
    uint16_t selector;
    uint8_t  ist;
    uint8_t  type_attr;
    uint16_t offset_mid;
    uint32_t offset_high;
    uint32_t zero;
} __attribute__((packed));

struct idt_ptr {
    uint16_t limit;
    uint64_t base;
} __attribute__((packed));

static struct idt_entry idt[IDT_ENTRIES];
static isr_handler_t    handlers[IDT_ENTRIES];

extern void *isr_stub_table[];

static void idt_set_gate(uint8_t vec, uint64_t handler, uint8_t type_attr)
{
    idt[vec].offset_low  = (uint16_t)(handler & 0xFFFF);
    idt[vec].selector    = KERNEL_CS;
    idt[vec].ist         = 0;
    idt[vec].type_attr   = type_attr;
    idt[vec].offset_mid  = (uint16_t)((handler >> 16) & 0xFFFF);
    idt[vec].offset_high = (uint32_t)((handler >> 32) & 0xFFFFFFFF);
    idt[vec].zero        = 0;
}

void pic_remap(void)
{
    uint8_t a1 = inb(PIC1_DATA);
    uint8_t a2 = inb(PIC2_DATA);

    /* start init sequence (cascade mode) */
    outb(PIC1_CMD, 0x11);
    io_wait();
    outb(PIC2_CMD, 0x11);
    io_wait();

    /* vector offsets: master 32-39, slave 40-47 */
    outb(PIC1_DATA, 0x20);
    io_wait();
    outb(PIC2_DATA, 0x28);
    io_wait();

    /* wiring: slave on IRQ2 */
    outb(PIC1_DATA, 0x04);
    io_wait();
    outb(PIC2_DATA, 0x02);
    io_wait();

    /* 8086 mode */
    outb(PIC1_DATA, 0x01);
    io_wait();
    outb(PIC2_DATA, 0x01);
    io_wait();

    /* restore masks */
    outb(PIC1_DATA, a1);
    outb(PIC2_DATA, a2);
}

void pic_send_eoi(uint8_t irq)
{
    if (irq >= 8)
        outb(PIC2_CMD, PIC_EOI);
    outb(PIC1_CMD, PIC_EOI);
}

void irq_set_mask(uint8_t irq)
{
    uint16_t port;
    uint8_t value;

    if (irq < 8) {
        port = PIC1_DATA;
    } else {
        port = PIC2_DATA;
        irq = (uint8_t)(irq - 8);
    }
    value = (uint8_t)(inb(port) | (1u << irq));
    outb(port, value);
}

void irq_clear_mask(uint8_t irq)
{
    uint16_t port;
    uint8_t value;

    if (irq < 8) {
        port = PIC1_DATA;
    } else {
        port = PIC2_DATA;
        irq = (uint8_t)(irq - 8);
    }
    value = (uint8_t)(inb(port) & ~(1u << irq));
    outb(port, value);
}

void idt_register_handler(uint8_t vector, isr_handler_t handler)
{
    handlers[vector] = handler;
}

static const char *exception_name(uint64_t n)
{
    static const char *names[] = {
        "Divide Error",
        "Debug",
        "NMI",
        "Breakpoint",
        "Overflow",
        "Bound Range",
        "Invalid Opcode",
        "Device Not Available",
        "Double Fault",
        "Coprocessor Segment",
        "Invalid TSS",
        "Segment Not Present",
        "Stack Fault",
        "General Protection",
        "Page Fault",
        "Reserved",
        "x87 FP",
        "Alignment Check",
        "Machine Check",
        "SIMD FP",
        "Virtualization",
        "Control Protection",
    };
    if (n < sizeof(names) / sizeof(names[0]))
        return names[n];
    return "Unknown";
}

void isr_dispatch(struct interrupt_frame *frame)
{
    uint64_t vec = frame->int_no;

    if (handlers[vec]) {
        handlers[vec](frame);
    } else if (vec < 32) {
        vga_set_color(VGA_COLOR_LIGHT_RED, VGA_COLOR_BLACK);
        vga_write("\nEXCEPTION #");
        vga_write_dec((int64_t)vec);
        vga_write(" ");
        vga_write(exception_name(vec));
        vga_write(" err=");
        vga_write_hex(frame->err_code);
        vga_write(" rip=");
        vga_write_hex(frame->rip);
        vga_write("\n");
        vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
        for (;;) {
            cli();
            hlt();
        }
    }

    /* EOI for hardware IRQs (vectors 32-47) */
    if (vec >= 32 && vec < 48)
        pic_send_eoi((uint8_t)(vec - 32));
}

void idt_init(void)
{
    struct idt_ptr ip;
    int i;

    memset(idt, 0, sizeof(idt));
    memset(handlers, 0, sizeof(handlers));

    pic_remap();

    /* Mask all IRQs initially; drivers unmask what they need. */
    outb(PIC1_DATA, 0xFF);
    outb(PIC2_DATA, 0xFF);

    for (i = 0; i < 48; i++) {
        uint64_t addr = (uint64_t)isr_stub_table[i];
        /* present | ring0 | 64-bit interrupt gate */
        idt_set_gate((uint8_t)i, addr, 0x8E);
    }

    ip.limit = sizeof(idt) - 1;
    ip.base  = (uint64_t)&idt;
    __asm__ volatile("lidt %0" : : "m"(ip) : "memory");
}
