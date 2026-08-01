#include "two_station_model_data.h"

/*
 * Generated from calibration/two_station_20260731.json.
 * Right device/address: 1/0100.
 * Left device/address: 2/0200.
 * Runtime angle remains diagnostic only.
 */
static const UwbTwoStationPrototype g_two_station_prototypes_20260731[] = {
    {750U, 743U, 800U, 0, 0U},
    {785U, 873U, 800U, 45, 0U},
    {1108U, 828U, 900U, -45, 0U},
    {860U, 977U, 900U, 45, 0U},
    {1397U, 1073U, 1000U, -45, 0U},
    {1043U, 943U, 1000U, -30, 0U},
    {882U, 845U, 1000U, -15, 0U},
    {860U, 1117U, 1000U, 0, 0U},
    {885U, 1093U, 1000U, 15, 0U},
    {917U, 1157U, 1000U, 30, 0U},
    {943U, 1125U, 1000U, 45, 0U},
    {1430U, 815U, 1100U, -45, 0U},
    {1057U, 1190U, 1100U, 45, 0U},
    {1041U, 1187U, 1200U, 0, 0U},
    {1158U, 1298U, 1200U, 45, 0U},
    {1697U, 1843U, 1800U, 0, 0U},
    {1860U, 1993U, 1900U, 0, 0U},
    {2360U, 2280U, 2000U, -45, 0U},
    {2050U, 1752U, 2000U, -30, 0U},
    {1803U, 2002U, 2000U, -15, 0U},
    {2010U, 2037U, 2000U, 0, 0U},
    {1950U, 2007U, 2000U, 5, 0U},
    {1987U, 2953U, 2000U, 10, 0U},
    {1930U, 2410U, 2000U, 15, 0U},
    {1868U, 2037U, 2000U, 20, 0U},
    {2077U, 2660U, 2000U, 25, 0U},
    {1903U, 2133U, 2000U, 35, 0U},
    {1837U, 2020U, 2000U, 40, 0U},
    {2070U, 2153U, 2000U, 45, 0U},
    {2663U, 2600U, 2800U, 0, 0U},
    {3355U, 3317U, 3000U, -45, 0U},
    {3477U, 3020U, 3000U, -30, 0U},
    {3067U, 3023U, 3000U, -15, 0U},
    {3050U, 3070U, 3000U, 0, 0U},
    {3133U, 3643U, 3000U, 5, 0U},
    {2950U, 3167U, 3000U, 10, 0U},
    {3100U, 2900U, 3000U, 15, 0U},
    {2987U, 4327U, 3000U, 20, 0U},
    {3197U, 3310U, 3000U, 25, 0U},
    {3352U, 3762U, 3000U, 30, 0U},
    {3127U, 3343U, 3000U, 35, 0U},
    {3147U, 3087U, 3000U, 40, 0U},
    {3180U, 4553U, 3000U, 45, 0U},
};

const UwbTwoStationModel g_two_station_model_20260731 = {
    .magic = UWB_TWO_STATION_MODEL_MAGIC,
    .version = UWB_TWO_STATION_MODEL_VERSION,
    .prototype_count =
        (uint16_t)(sizeof(g_two_station_prototypes_20260731) /
                   sizeof(g_two_station_prototypes_20260731[0])),
    .serialized_bytes = UWB_TWO_STATION_MODEL_SERIALIZED_BYTES,
    .station_address = {
        0x0100U,
        0x0200U
    },
    .window_ms = 800U,
    .pair_skew_ms = 120U,
    .update_period_ms = 100U,
    .hold_ms = 500U,
    .scale_right_q16 = 86394798UL,
    .scale_left_q16 = 134086001UL,
    .q_floor_q24 = 6711UL,
    .high_nearest_q24 = 6710886UL,
    .minimum_distance_mm = 800U,
    .maximum_distance_mm = 3000U,
    .crc32 = 0x91F6EF14UL,
    .prototypes = g_two_station_prototypes_20260731,
};
