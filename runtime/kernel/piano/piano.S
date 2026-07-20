/* Main piano application startup and keyboard handling for x86_64 bare-metal kernel. */

/* Piano main application */
void piano_main(void);

/* Entry point - called from kernel boot */
void piano_main(void);

void piano_entry(void)
{
    /* Call piano application */
    piano_main();

    /* Should never return */
    while (1) {
        __asm__ volatile("hlt");
    }
}

/* Define global symbol for linker */
.global piano_entry
.type piano_entry, @function
piano_entry: