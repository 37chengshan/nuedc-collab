#include "lock_output_behavior.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static unsigned int g_assertions;

#define TEST_ASSERT(condition)                                                  \
    do {                                                                        \
        g_assertions++;                                                         \
        if (!(condition)) {                                                     \
            fprintf(stderr, "%s:%d: assertion failed: %s\n", __FILE__,        \
                    __LINE__, #condition);                                      \
            return false;                                                       \
        }                                                                       \
    } while (0)

static bool test_locked_and_unlocked_outputs(void)
{
    LockOutputBehavior behavior;
    LockOutputSnapshot logical;
    LockPhysicalOutputs physical;

    lock_output_behavior_init(&behavior);
    memset(&logical, 0, sizeof(logical));
    physical = lock_output_behavior_update(&behavior, &logical, 0U);
    TEST_ASSERT(!physical.red_on);
    TEST_ASSERT(!physical.green_on);
    TEST_ASSERT(!physical.buzzer_on);
    TEST_ASSERT(!physical.lock_on);

    memset(&logical, 0, sizeof(logical));
    logical.unlock_output = true;
    logical.welcome_output = true;
    logical.green_led = true;
    physical = lock_output_behavior_update(&behavior, &logical, 1000U);
    TEST_ASSERT(!physical.red_on);
    TEST_ASSERT(physical.green_on);
    TEST_ASSERT(physical.buzzer_on);
    TEST_ASSERT(physical.lock_on);
    physical = lock_output_behavior_update(&behavior, &logical, 1069U);
    TEST_ASSERT(physical.buzzer_on);
    physical = lock_output_behavior_update(&behavior, &logical, 1070U);
    TEST_ASSERT(!physical.buzzer_on);
    physical = lock_output_behavior_update(&behavior, &logical, 1170U);
    TEST_ASSERT(physical.buzzer_on);
    physical = lock_output_behavior_update(&behavior, &logical, 1240U);
    TEST_ASSERT(!physical.buzzer_on);
    return true;
}

static bool test_welcome_led_is_separate_and_beeps_once(void)
{
    LockOutputBehavior behavior;
    LockOutputSnapshot logical;
    LockPhysicalOutputs physical;

    lock_output_behavior_init(&behavior);
    memset(&logical, 0, sizeof(logical));
    logical.welcome_output = true;
    logical.red_led = true;

    physical = lock_output_behavior_update(&behavior, &logical, 0U);
    TEST_ASSERT(!physical.red_on);
    TEST_ASSERT(!physical.green_on);
    TEST_ASSERT(physical.buzzer_on);

    physical = lock_output_behavior_update(&behavior, &logical, 79U);
    TEST_ASSERT(physical.buzzer_on);
    physical = lock_output_behavior_update(&behavior, &logical, 80U);
    TEST_ASSERT(!physical.buzzer_on);

    logical.unlock_output = true;
    physical = lock_output_behavior_update(&behavior, &logical, 500U);
    TEST_ASSERT(!physical.buzzer_on);
    TEST_ASSERT(physical.lock_on);

    physical = lock_output_behavior_update(&behavior, &logical, 500U);
    TEST_ASSERT(!physical.green_on);
    TEST_ASSERT(!physical.buzzer_on);

    memset(&logical, 0, sizeof(logical));
    (void)lock_output_behavior_update(&behavior, &logical, 100U);
    logical.welcome_output = true;
    physical = lock_output_behavior_update(&behavior, &logical, 200U);
    TEST_ASSERT(!physical.buzzer_on);
    memset(&logical, 0, sizeof(logical));
    (void)lock_output_behavior_update(&behavior, &logical, 300U);
    logical.welcome_output = true;
    physical = lock_output_behavior_update(&behavior, &logical, 2100U);
    TEST_ASSERT(physical.buzzer_on);
    return true;
}

static bool test_denied_alarm_and_null_are_safe(void)
{
    LockOutputBehavior behavior;
    LockOutputSnapshot logical;
    LockPhysicalOutputs physical;

    lock_output_behavior_init(&behavior);
    memset(&logical, 0, sizeof(logical));
    logical.red_led = true;
    logical.buzzer_alarm = true;

    physical = lock_output_behavior_update(&behavior, &logical, 5000U);
    TEST_ASSERT(physical.red_on);
    TEST_ASSERT(!physical.green_on);
    TEST_ASSERT(physical.buzzer_on);
    TEST_ASSERT(!physical.lock_on);
    physical = lock_output_behavior_update(&behavior, &logical, 5999U);
    TEST_ASSERT(physical.buzzer_on);
    physical = lock_output_behavior_update(&behavior, &logical, 6000U);
    TEST_ASSERT(!physical.buzzer_on);

    physical = lock_output_behavior_update(&behavior, NULL, 5001U);
    TEST_ASSERT(!physical.red_on);
    TEST_ASSERT(!physical.green_on);
    TEST_ASSERT(!physical.buzzer_on);
    TEST_ASSERT(!physical.lock_on);
    return true;
}

int main(void)
{
    unsigned int failures = 0U;

    if (!test_locked_and_unlocked_outputs()) {
        failures++;
    }
    if (!test_welcome_led_is_separate_and_beeps_once()) {
        failures++;
    }
    if (!test_denied_alarm_and_null_are_safe()) {
        failures++;
    }

    printf("%u assertions, %u failures\n", g_assertions, failures);
    return failures == 0U ? 0 : 1;
}
