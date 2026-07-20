#include "gdt.h"
#include "string.h"

/* 64-bit GDT entry (8 bytes) and TSS descriptor (16 bytes). */
struct gdt_entry {
    uint16_t limit_low;
    uint16_t base_low;
    uint8_t  base_mid;
    uint8_t  access;
    uint8_t  granularity;
    uint8_t  base_high;
} __attribute__((packed));

struct gdt_tss_entry {
    uint16_t limit_low;
    uint16_t base_low;
    uint8_t  base_mid;
    uint8_t  access;
    uint8_t  granularity;
    uint8_t  base_high;
    uint32_t base_upper;
    uint32_t reserved;
} __attribute__((packed));

struct gdt_ptr {
    uint16_t limit;
    uint64_t base;
} __attribute__((packed));

/* Minimal 64-bit TSS. */
struct tss {
    uint32_t reserved0;
    uint64_t rsp0;
    uint64_t rsp1;
    uint64_t rsp2;
    uint64_t reserved1;
    uint64_t ist1;
    uint64_t ist2;
    uint64_t ist3;
    uint64_t ist4;
    uint64_t ist5;
    uint64_t ist6;
    uint64_t ist7;
    uint64_t reserved2;
    uint16_t reserved3;
    uint16_t iomap_base;
} __attribute__((packed));

struct gdt_table {
    struct gdt_entry     null;
    struct gdt_entry     kernel_code;
    struct gdt_entry     kernel_data;
    struct gdt_entry     user_code;
    struct gdt_entry     user_data;
    struct gdt_tss_entry tss;
} __attribute__((packed));

static struct gdt_table gdt;
static struct tss       tss;
static uint8_t          tss_stack[4096] __attribute__((aligned(16)));

static void gdt_set_entry(struct gdt_entry *e, uint32_t base, uint32_t limit,
                          uint8_t access, uint8_t gran)
{
    e->limit_low   = (uint16_t)(limit & 0xFFFF);
    e->base_low    = (uint16_t)(base & 0xFFFF);
    e->base_mid    = (uint8_t)((base >> 16) & 0xFF);
    e->access      = access;
    e->granularity = (uint8_t)(((limit >> 16) & 0x0F) | (gran & 0xF0));
    e->base_high   = (uint8_t)((base >> 24) & 0xFF);
}

static void gdt_set_tss(struct gdt_tss_entry *e, uint64_t base, uint32_t limit,
                        uint8_t access)
{
    e->limit_low   = (uint16_t)(limit & 0xFFFF);
    e->base_low    = (uint16_t)(base & 0xFFFF);
    e->base_mid    = (uint8_t)((base >> 16) & 0xFF);
    e->access      = access;
    e->granularity = (uint8_t)((limit >> 16) & 0x0F);
    e->base_high   = (uint8_t)((base >> 24) & 0xFF);
    e->base_upper  = (uint32_t)(base >> 32);
    e->reserved    = 0;
}

void gdt_init(void)
{
    struct gdt_ptr gp;
    uint64_t tss_base;

    memset(&gdt, 0, sizeof(gdt));
    memset(&tss, 0, sizeof(tss));

    /* Null descriptor */
    gdt_set_entry(&gdt.null, 0, 0, 0, 0);

    /* Kernel 64-bit code: base=0 limit=0xFFFFF, access=0x9A, flags=L+G */
    gdt_set_entry(&gdt.kernel_code, 0, 0xFFFFF, 0x9A, 0xA0);

    /* Kernel data: access=0x92, flags=G (32-bit style ok in long mode) */
    gdt_set_entry(&gdt.kernel_data, 0, 0xFFFFF, 0x92, 0xC0);

    /* User 64-bit code (RPL 3): access=0xFA, flags=L+G */
    gdt_set_entry(&gdt.user_code, 0, 0xFFFFF, 0xFA, 0xA0);

    /* User data: access=0xF2 */
    gdt_set_entry(&gdt.user_data, 0, 0xFFFFF, 0xF2, 0xC0);

    /* TSS */
    tss.rsp0 = (uint64_t)(tss_stack + sizeof(tss_stack));
    tss.iomap_base = sizeof(tss);
    tss_base = (uint64_t)&tss;
    gdt_set_tss(&gdt.tss, tss_base, sizeof(tss) - 1, 0x89);

    gp.limit = sizeof(gdt) - 1;
    gp.base  = (uint64_t)&gdt;

    __asm__ volatile(
        "lgdt %0\n"
        "pushq %[kcs]\n"
        "leaq 1f(%%rip), %%rax\n"
        "pushq %%rax\n"
        "lretq\n"
        "1:\n"
        "mov %[kds], %%ax\n"
        "mov %%ax, %%ds\n"
        "mov %%ax, %%es\n"
        "mov %%ax, %%ss\n"
        "mov %%ax, %%fs\n"
        "mov %%ax, %%gs\n"
        :
        : "m"(gp), [kcs] "i"(KERNEL_CS), [kds] "r"((uint16_t)KERNEL_DS)
        : "rax", "memory");

    __asm__ volatile("ltr %0" : : "r"((uint16_t)KERNEL_TSS) : "memory");
}
