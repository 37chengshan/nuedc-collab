#include "empirical_model.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

typedef struct {
    const EmpiricalPrototypeV1 *prototype;
    float distance_squared;
} EmpiricalNeighbor;

static uint32_t crc_byte(uint32_t crc, uint8_t value)
{
    uint8_t bit;

    crc ^= value;
    for (bit = 0U; bit < 8U; bit++) {
        crc = (crc >> 1U) ^
              ((crc & 1U) != 0U ? 0xEDB88320UL : 0UL);
    }
    return crc;
}

static uint32_t crc_u16(uint32_t crc, uint16_t value)
{
    crc = crc_byte(crc, (uint8_t)(value & 0xFFU));
    return crc_byte(crc, (uint8_t)((value >> 8U) & 0xFFU));
}

static uint32_t crc_u32(uint32_t crc, uint32_t value)
{
    uint8_t index;

    for (index = 0U; index < 4U; index++) {
        crc = crc_byte(crc, (uint8_t)((value >> (index * 8U)) & 0xFFU));
    }
    return crc;
}

static uint32_t crc_float(uint32_t crc, float value)
{
    uint32_t bits;

    memcpy(&bits, &value, sizeof(bits));
    return crc_u32(crc, bits);
}

uint32_t empirical_model_compute_crc(const EmpiricalModelV1 *model)
{
    uint32_t crc = 0xFFFFFFFFUL;
    uint16_t index;

    if ((model == NULL) || (model->prototypes == NULL) ||
        ((model->primary_knot_count > 0U) &&
         (model->primary_knots == NULL))) {
        return 0U;
    }

    crc = crc_u32(crc, model->magic);
    crc = crc_u16(crc, model->version);
    crc = crc_u16(crc, model->prototype_count);
    crc = crc_byte(crc, model->distance_neighbor_count);
    crc = crc_byte(crc, model->angle_neighbor_count);
    crc = crc_byte(crc, model->primary_knot_count);
    crc = crc_byte(crc, model->reserved);
    crc = crc_float(crc, model->distance1_scale_mm);
    crc = crc_float(crc, model->distance2_scale_mm);
    crc = crc_float(crc, model->distance_knn_blend);
    crc = crc_float(crc, model->known_prototype_radius);
    crc = crc_float(crc, model->angle_max_neighbor_distance);
    crc = crc_float(crc, model->angle_max_spread_deg);
    for (index = 0U; index < model->prototype_count; index++) {
        const EmpiricalPrototypeV1 *prototype = &model->prototypes[index];

        crc = crc_u16(crc, prototype->distance1_mm);
        crc = crc_u16(crc, prototype->distance2_mm);
        crc = crc_u16(crc, prototype->radial_mm);
        crc = crc_u16(crc, (uint16_t)prototype->bearing_cdeg);
        crc = crc_byte(crc, prototype->flags);
        crc = crc_byte(crc, prototype->reserved);
    }
    for (index = 0U; index < model->primary_knot_count; index++) {
        const EmpiricalRangeKnotV1 *knot = &model->primary_knots[index];

        crc = crc_u16(crc, knot->measured_mm);
        crc = crc_u16(crc, knot->radial_mm);
    }
    return crc ^ 0xFFFFFFFFUL;
}

void empirical_model_refresh_crc(EmpiricalModelV1 *model)
{
    if (model != NULL) {
        model->crc32 = empirical_model_compute_crc(model);
    }
}

EmpiricalModelStatus empirical_model_validate(const EmpiricalModelV1 *model)
{
    uint8_t knot_index;

    if ((model == NULL) || (model->prototypes == NULL)) {
        return EMPIRICAL_MODEL_NULL_ERROR;
    }
    if ((model->primary_knot_count > 0U) &&
        (model->primary_knots == NULL)) {
        return EMPIRICAL_MODEL_NULL_ERROR;
    }
    if (model->magic != EMPIRICAL_MODEL_V1_MAGIC) {
        return EMPIRICAL_MODEL_MAGIC_ERROR;
    }
    if (model->version != EMPIRICAL_MODEL_V1_VERSION) {
        return EMPIRICAL_MODEL_VERSION_ERROR;
    }
    if ((model->prototype_count == 0U) ||
        (model->prototype_count > EMPIRICAL_MODEL_MAX_PROTOTYPES) ||
        (model->distance_neighbor_count == 0U) ||
        (model->distance_neighbor_count > EMPIRICAL_MODEL_MAX_NEIGHBORS) ||
        (model->distance_neighbor_count > model->prototype_count) ||
        (model->angle_neighbor_count == 0U) ||
        (model->angle_neighbor_count > EMPIRICAL_MODEL_MAX_NEIGHBORS) ||
        (model->angle_neighbor_count > model->prototype_count)) {
        return EMPIRICAL_MODEL_COUNT_ERROR;
    }
    if ((model->primary_knot_count > EMPIRICAL_MODEL_MAX_PRIMARY_KNOTS) ||
        ((model->distance_knn_blend < 1.0f) &&
         ((model->primary_knot_count < 2U) ||
          (model->primary_knots == NULL)))) {
        return EMPIRICAL_MODEL_COUNT_ERROR;
    }
    if (!isfinite(model->distance1_scale_mm) ||
        !isfinite(model->distance2_scale_mm) ||
        !isfinite(model->distance_knn_blend) ||
        !isfinite(model->known_prototype_radius) ||
        !isfinite(model->angle_max_neighbor_distance) ||
        !isfinite(model->angle_max_spread_deg) ||
        (model->distance1_scale_mm <= 0.0f) ||
        (model->distance2_scale_mm <= 0.0f) ||
        (model->distance_knn_blend < 0.0f) ||
        (model->distance_knn_blend > 1.0f) ||
        (model->known_prototype_radius < 0.0f) ||
        (model->angle_max_neighbor_distance <= 0.0f) ||
        (model->angle_max_spread_deg <= 0.0f)) {
        return EMPIRICAL_MODEL_PARAMETER_ERROR;
    }
    for (knot_index = 1U; knot_index < model->primary_knot_count;
         knot_index++) {
        if (model->primary_knots[knot_index].measured_mm <=
            model->primary_knots[knot_index - 1U].measured_mm) {
            return EMPIRICAL_MODEL_PARAMETER_ERROR;
        }
    }
    if (model->crc32 != empirical_model_compute_crc(model)) {
        return EMPIRICAL_MODEL_CRC_ERROR;
    }
    return EMPIRICAL_MODEL_OK;
}

static float feature_distance_squared(const EmpiricalModelV1 *model,
                                      uint16_t distance1_mm,
                                      uint16_t distance2_mm,
                                      const EmpiricalPrototypeV1 *prototype)
{
    float delta1 =
        ((float)distance1_mm - (float)prototype->distance1_mm) /
        model->distance1_scale_mm;
    float delta2 =
        ((float)distance2_mm - (float)prototype->distance2_mm) /
        model->distance2_scale_mm;

    return (delta1 * delta1) + (delta2 * delta2);
}

static void insert_neighbor(EmpiricalNeighbor *neighbors, uint8_t *count,
                            uint8_t capacity,
                            const EmpiricalPrototypeV1 *prototype,
                            float distance_squared)
{
    uint8_t insertion;
    uint8_t index;

    insertion = *count;
    for (index = 0U; index < *count; index++) {
        if (distance_squared < neighbors[index].distance_squared) {
            insertion = index;
            break;
        }
    }
    if ((insertion >= capacity) && (*count >= capacity)) {
        return;
    }
    if (*count < capacity) {
        (*count)++;
    }
    for (index = (uint8_t)(*count - 1U); index > insertion; index--) {
        neighbors[index] = neighbors[index - 1U];
    }
    neighbors[insertion].prototype = prototype;
    neighbors[insertion].distance_squared = distance_squared;
}

static float weighted_distance(const EmpiricalNeighbor *neighbors,
                               uint8_t count)
{
    float weighted = 0.0f;
    float total_weight = 0.0f;
    uint8_t index;

    if (neighbors[0].distance_squared < 1.0e-12f) {
        float total = 0.0f;
        uint8_t exact_count = 0U;

        for (index = 0U;
             (index < count) &&
             (neighbors[index].distance_squared < 1.0e-12f);
             index++) {
            total += (float)neighbors[index].prototype->radial_mm;
            exact_count++;
        }
        return total / (float)exact_count;
    }

    for (index = 0U; index < count; index++) {
        float denominator = neighbors[index].distance_squared;
        float weight;

        if (denominator < 0.0004f) {
            denominator = 0.0004f;
        }
        weight = 1.0f / denominator;
        weighted += weight * (float)neighbors[index].prototype->radial_mm;
        total_weight += weight;
    }
    return weighted / total_weight;
}

static float interpolate_primary_range(const EmpiricalModelV1 *model,
                                       uint16_t measured_mm)
{
    const EmpiricalRangeKnotV1 *left = &model->primary_knots[0];
    const EmpiricalRangeKnotV1 *right = &model->primary_knots[1];
    uint8_t index;
    float span;
    float ratio;

    if (measured_mm >=
        model->primary_knots[model->primary_knot_count - 1U].measured_mm) {
        left = &model->primary_knots[model->primary_knot_count - 2U];
        right = &model->primary_knots[model->primary_knot_count - 1U];
    } else if (measured_mm > model->primary_knots[0].measured_mm) {
        for (index = 1U; index < model->primary_knot_count; index++) {
            if (measured_mm <= model->primary_knots[index].measured_mm) {
                left = &model->primary_knots[index - 1U];
                right = &model->primary_knots[index];
                break;
            }
        }
    }

    span = (float)right->measured_mm - (float)left->measured_mm;
    if (fabsf(span) < 1.0e-6f) {
        return ((float)left->radial_mm + (float)right->radial_mm) * 0.5f;
    }
    ratio = ((float)measured_mm - (float)left->measured_mm) / span;
    return (float)left->radial_mm +
           ratio * ((float)right->radial_mm - (float)left->radial_mm);
}

static float blended_distance(const EmpiricalModelV1 *model,
                              const EmpiricalNeighbor *neighbors,
                              uint8_t count, uint16_t distance1_mm)
{
    float knn_distance = weighted_distance(neighbors, count);
    float effective_blend = model->distance_knn_blend;

    if ((model->distance_knn_blend >= 1.0f) ||
        (model->primary_knot_count < 2U) ||
        (model->primary_knots == NULL)) {
        return knn_distance;
    }
    if (model->known_prototype_radius > 0.0f) {
        float nearest = sqrtf(neighbors[0].distance_squared);
        float known_boost =
            1.0f - (nearest / model->known_prototype_radius);

        if (known_boost < 0.0f) {
            known_boost = 0.0f;
        } else if (known_boost > 1.0f) {
            known_boost = 1.0f;
        }
        effective_blend +=
            (1.0f - effective_blend) * known_boost;
    }
    return effective_blend * knn_distance +
           (1.0f - effective_blend) *
               interpolate_primary_range(model, distance1_mm);
}

static bool weighted_angle(const EmpiricalModelV1 *model,
                           const EmpiricalNeighbor *neighbors, uint8_t count,
                           float *bearing_deg)
{
    float minimum = 1000.0f;
    float maximum = -1000.0f;
    float weighted = 0.0f;
    float total_weight = 0.0f;
    uint8_t usable_count = count;
    uint8_t index;
    bool within_neighbor_limit =
        sqrtf(neighbors[0].distance_squared) <=
        model->angle_max_neighbor_distance;

    if (neighbors[0].distance_squared < 1.0e-12f) {
        usable_count = 0U;
        while ((usable_count < count) &&
               (neighbors[usable_count].distance_squared < 1.0e-12f)) {
            usable_count++;
        }
    }

    for (index = 0U; index < usable_count; index++) {
        float angle =
            (float)neighbors[index].prototype->bearing_cdeg / 100.0f;
        float denominator = neighbors[index].distance_squared;
        float weight;

        if (angle < minimum) {
            minimum = angle;
        }
        if (angle > maximum) {
            maximum = angle;
        }
        if (denominator < 0.0004f) {
            denominator = 0.0004f;
        }
        weight = 1.0f / denominator;
        weighted += weight * angle;
        total_weight += weight;
    }
    *bearing_deg = weighted / total_weight;
    return within_neighbor_limit &&
           ((maximum - minimum) <= model->angle_max_spread_deg);
}

bool empirical_model_predict(const EmpiricalModelV1 *model,
                             uint16_t distance1_mm,
                             uint16_t distance2_mm,
                             EmpiricalEstimate *estimate)
{
    EmpiricalNeighbor distance_neighbors[EMPIRICAL_MODEL_MAX_NEIGHBORS];
    EmpiricalNeighbor angle_neighbors[EMPIRICAL_MODEL_MAX_NEIGHBORS];
    uint8_t distance_count = 0U;
    uint8_t angle_count = 0U;
    uint16_t index;

    if (estimate == NULL) {
        return false;
    }
    memset(estimate, 0, sizeof(*estimate));
    if (empirical_model_validate(model) != EMPIRICAL_MODEL_OK) {
        return false;
    }

    for (index = 0U; index < model->prototype_count; index++) {
        const EmpiricalPrototypeV1 *prototype = &model->prototypes[index];
        float distance_squared = feature_distance_squared(
            model, distance1_mm, distance2_mm, prototype);

        insert_neighbor(distance_neighbors, &distance_count,
                        model->distance_neighbor_count, prototype,
                        distance_squared);
        if ((prototype->flags & EMPIRICAL_PROTOTYPE_ANGLE_VALID) != 0U) {
            insert_neighbor(angle_neighbors, &angle_count,
                            model->angle_neighbor_count, prototype,
                            distance_squared);
        }
    }
    if (distance_count == 0U) {
        return false;
    }

    estimate->valid = true;
    estimate->distance_mm =
        blended_distance(model, distance_neighbors, distance_count,
                         distance1_mm);
    estimate->distance_confidence =
        1.0f / (1.0f + sqrtf(distance_neighbors[0].distance_squared));
    if (angle_count > 0U) {
        estimate->angle_available = true;
        estimate->angle_valid =
            weighted_angle(model, angle_neighbors, angle_count,
                           &estimate->bearing_deg);
        estimate->angle_confidence =
            1.0f / (1.0f + sqrtf(angle_neighbors[0].distance_squared));
    }
    return true;
}
