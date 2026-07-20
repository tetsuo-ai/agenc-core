#ifndef KERNEL_PIANO_PIT_H
#define KERNEL_PIANO_PIT_H

#include "types.h"

/* PIT Channel 2 ports */
#define PIT_BASE       0x40          /* Channel 0 is at 0x40, Channel 1 at 0x41, Channel 2 at 0x42 */
#define PIT_LATCH_LO   (PIT_BASE + 0)
#define PIT_LATCH_HI   (PIT_BASE + 1)
#define PIT_CONTROL    (PIT_BASE + 2)
#define PIT_STATUS     0x61          /* Port 0x61 for speaker control */

/* PIT control byte bits */
#define PIT_BINARY     (1 << 0)      /* 0=BCD mode, 1=binary */
#define PIT_BCD        (0 << 0)
#define PIT_MODE       (0b011 << 1)  /* Mode 3: square wave generator */
#define PIT_ACCESS     (0b11 << 4)   /* 11=access both bytes */

/* Speaker control bits */
#define SPEAKER_ENABLE (1 << 0)      /* Bit 0: speaker enable */
#define TIMER2_SEL     (1 << 1)      /* Bit 1: speaker enable (channel 2) */

/* PIT frequency constants (in Hz) */
#define PIT_FREQ       1193180       /* 1.193 MHz default PIT frequency */

/* C major scale frequencies (Hz) */
#define NOTE_C4        261
#define NOTE_D4        293
#define NOTE_E4        330
#define NOTE_F4        349
#define NOTE_G4        392
#define NOTE_A4        440
#define NOTE_B4        494
#define NOTE_C5        523

/* PIT reload values for square wave generation */
#define PIT_TO_C4     (PIT_FREQ / NOTE_C4)
#define PIT_TO_D4     (PIT_FREQ / NOTE_D4)
#define PIT_TO_E4     (PIT_FREQ / NOTE_E4)
#define PIT_TO_F4     (PIT_FREQ / NOTE_F4)
#define PIT_TO_G4     (PIT_FREQ / NOTE_G4)
#define PIT_TO_A4     (PIT_FREQ / NOTE_A4)
#define PIT_TO_B4     (PIT_FREQ / NOTE_B4)
#define PIT_TO_C5     (PIT_FREQ / NOTE_C5)

/* Speaker control */
static inline void speaker_enable(uint8_t enable)
{
    uint8_t val = inb(PIT_STATUS);
    if (enable)
        val |= (SPEAKER_ENABLE | TIMER2_SEL);
    else
        val &= ~(SPEAKER_ENABLE | TIMER2_SEL);
    outb(PIT_STATUS, val);
}

/* Write a divisor to PIT channel 2 */
static inline void pit_set_divisor(uint16_t divisor)
{
    outb(PIT_CONTROL, PIT_ACCESS | PIT_MODE | PIT_BINARY);
    outb(PIT_LATCH_LO, (uint8_t)(divisor & 0xFF));
    outb(PIT_LATCH_HI, (uint8_t)((divisor >> 8) & 0xFF));
    /* Wait for latch to complete */
    inb(PIT_CONTROL);
    inb(PIT_LATCH_LO);
    inb(PIT_LATCH_HI);
    inb(PIT_STATUS);
}

/* Initialize PIT channel 2 for square wave generation */
static inline void pit_channel2_init(void)
{
    speaker_enable(0);              /* Turn off speaker */
    pit_set_divisor(0);             /* Disable channel 2 by setting divisor to 0 */
    speaker_enable(1);              /* Turn on speaker */
}

#endif /* KERNEL_PIANO_PIT_H */