#include "lock_distance_stabilizer.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

static int failures = 0;
static int assertions = 0;

#define TEST_ASSERT(condition)                                                \
    do {                                                                      \
        assertions++;                                                         \
        if (!(condition)) {                                                   \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);       \
            failures++;                                                       \
            return false;                                                     \
        }                                                                     \
    } while (0)

#define TEST_ASSERT_NEAR(actual, expected, tolerance)                         \
    TEST_ASSERT(fabsf((actual) - (expected)) <= (tolerance))

static bool test_small_changes_are_smoothed(void)
{
    LockDistanceStabilizer stabilizer;
    float value;

    lock_distance_stabilizer_reset(&stabilizer);
    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1000.0f);
    TEST_ASSERT_NEAR(value, 1000.0f, 0.1f);

    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1100.0f);
    TEST_ASSERT(value > 1000.0f);
    TEST_ASSERT(value < 1100.0f);
    TEST_ASSERT_NEAR(value, 1025.0f, 0.1f);
    return true;
}

static bool test_isolated_large_jump_is_held(void)
{
    LockDistanceStabilizer stabilizer;
    float value;

    lock_distance_stabilizer_reset(&stabilizer);
    (void)lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1500.0f);
    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 2000.0f);
    TEST_ASSERT_NEAR(value, 1500.0f, 0.1f);

    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1510.0f);
    TEST_ASSERT(value >= 1500.0f);
    TEST_ASSERT(value < 1510.0f);
    return true;
}

static bool test_sustained_large_jump_is_accepted_after_three_updates(void)
{
    LockDistanceStabilizer stabilizer;
    float value;

    lock_distance_stabilizer_reset(&stabilizer);
    (void)lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1500.0f);

    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1980.0f);
    TEST_ASSERT_NEAR(value, 1500.0f, 0.1f);
    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 2020.0f);
    TEST_ASSERT_NEAR(value, 1500.0f, 0.1f);
    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 2000.0f);
    TEST_ASSERT_NEAR(value, 2000.0f, 0.1f);
    return true;
}

static bool test_key_change_resets_without_old_distance_drag(void)
{
    LockDistanceStabilizer stabilizer;
    float value;

    lock_distance_stabilizer_reset(&stabilizer);
    (void)lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 3U, 1000.0f);
    value = lock_distance_stabilizer_update(
        &stabilizer, 0x0100U, 4U, 2000.0f);
    TEST_ASSERT_NEAR(value, 2000.0f, 0.1f);
    return true;
}

int main(void)
{
    if (test_small_changes_are_smoothed()) {
        printf("PASS small distance changes are smoothed\n");
    }
    if (test_isolated_large_jump_is_held()) {
        printf("PASS isolated distance jump is held\n");
    }
    if (test_sustained_large_jump_is_accepted_after_three_updates()) {
        printf("PASS sustained distance jump is confirmed\n");
    }
    if (test_key_change_resets_without_old_distance_drag()) {
        printf("PASS key change resets distance state\n");
    }
    printf("%d assertions, %d failures\n", assertions, failures);
    return failures == 0 ? 0 : 1;
}
