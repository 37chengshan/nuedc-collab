#include "lock_app.h"
#include "two_station_model_data.h"
#include "uwb_two_station_estimator.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#define HOST_BENCHMARK_BATCHES 100U
#define HOST_BENCHMARK_UPDATES_PER_BATCH 1000U
#define HOST_UART_RING_BYTES (2U * 512U)
#define TARGET_STATIC_RAM_BUDGET_BYTES (12U * 1024U)

static uint64_t elapsed_ns(const struct timespec *start,
                           const struct timespec *end)
{
    return ((uint64_t)(end->tv_sec - start->tv_sec) * 1000000000ULL) +
           (uint64_t)(end->tv_nsec - start->tv_nsec);
}

static bool push_pair(UwbTwoStationEstimator *estimator,
                      uint32_t timestamp_ms)
{
    UwbTwoStationSample right;
    UwbTwoStationSample left;

    memset(&right, 0, sizeof(right));
    memset(&left, 0, sizeof(left));
    right.range_mm = 2010U;
    right.station_address =
        estimator->model->station_address[UWB_TWO_STATION_RIGHT];
    right.target_address_valid = true;
    right.target_address = 0x0A01U;
    right.snr_valid = true;
    right.snr_db = 10;
    right.timestamp_ms = timestamp_ms;
    left.range_mm = 2037U;
    left.station_address =
        estimator->model->station_address[UWB_TWO_STATION_LEFT];
    left.target_address_valid = true;
    left.target_address = 0x0A01U;
    left.snr_valid = true;
    left.snr_db = 0;
    left.timestamp_ms = timestamp_ms;

    return uwb_two_station_estimator_push(
               estimator, UWB_TWO_STATION_RIGHT, &right) &&
           uwb_two_station_estimator_push(
               estimator, UWB_TWO_STATION_LEFT, &left);
}

int main(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;
    struct timespec total_start;
    struct timespec total_end;
    uint64_t maximum_batch_ns = 0U;
    uint32_t timestamp_ms = 0U;
    volatile uint32_t checksum = 0U;
    size_t static_host_bytes =
        sizeof(LockApp) + HOST_UART_RING_BYTES;
    uint32_t batch;

    if (static_host_bytes > TARGET_STATIC_RAM_BUDGET_BYTES) {
        fprintf(stderr, "host static budget exceeded: %zu B\n",
                static_host_bytes);
        return 1;
    }
    if (!uwb_two_station_estimator_init(
            &estimator, &g_two_station_model_20260731)) {
        fprintf(stderr, "model initialization failed\n");
        return 1;
    }
    for (batch = 0U; batch < 8U; batch++) {
        timestamp_ms += 100U;
        if (!push_pair(&estimator, timestamp_ms) ||
            !uwb_two_station_estimator_update(
                &estimator, timestamp_ms, &result)) {
            fprintf(stderr, "warmup failed\n");
            return 1;
        }
    }

    if (clock_gettime(CLOCK_MONOTONIC, &total_start) != 0) {
        return 1;
    }
    for (batch = 0U; batch < HOST_BENCHMARK_BATCHES; batch++) {
        struct timespec batch_start;
        struct timespec batch_end;
        uint32_t update;
        uint64_t batch_ns;

        if (clock_gettime(CLOCK_MONOTONIC, &batch_start) != 0) {
            return 1;
        }
        for (update = 0U;
             update < HOST_BENCHMARK_UPDATES_PER_BATCH; update++) {
            timestamp_ms += 100U;
            if (!push_pair(&estimator, timestamp_ms) ||
                !uwb_two_station_estimator_update(
                    &estimator, timestamp_ms, &result)) {
                fprintf(stderr, "benchmark update failed\n");
                return 1;
            }
            checksum += result.distance_mm;
            checksum += (uint32_t)result.distance_quality;
        }
        if (clock_gettime(CLOCK_MONOTONIC, &batch_end) != 0) {
            return 1;
        }
        batch_ns = elapsed_ns(&batch_start, &batch_end);
        if (batch_ns > maximum_batch_ns) {
            maximum_batch_ns = batch_ns;
        }
    }
    if (clock_gettime(CLOCK_MONOTONIC, &total_end) != 0) {
        return 1;
    }

    {
        uint64_t total_updates =
            (uint64_t)HOST_BENCHMARK_BATCHES *
            HOST_BENCHMARK_UPDATES_PER_BATCH;
        uint64_t total_ns = elapsed_ns(&total_start, &total_end);
        double average_us =
            (double)total_ns / (double)total_updates / 1000.0;
        double maximum_batch_average_us =
            (double)maximum_batch_ns /
            HOST_BENCHMARK_UPDATES_PER_BATCH / 1000.0;

        printf("HOST ONLY; not MSPM0 WCET\n");
        printf("LockApp=%zu B Estimator=%zu B Result=%zu B "
               "Model=%zu B Prototype=%zu B\n",
               sizeof(LockApp), sizeof(UwbTwoStationEstimator),
               sizeof(UwbTwoStationResult), sizeof(UwbTwoStationModel),
               sizeof(UwbTwoStationPrototype));
        printf("LockApp+2x512B_UART=%zu B targetBudget=%u B\n",
               static_host_bytes, TARGET_STATIC_RAM_BUDGET_BYTES);
        printf("updates=%llu average=%.3f us "
               "maxBatchAverage=%.3f us checksum=%u\n",
               (unsigned long long)total_updates, average_us,
               maximum_batch_average_us, checksum);
    }
    return 0;
}
