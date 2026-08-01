"""Small dependency-light mesh toolkit for the C-problem printable models.

The project intentionally avoids a required CAD application.  Meshes are built
from closed primitives, exported as binary STL, and checked for degenerate
triangles and unmatched edges before being published.
"""

from __future__ import annotations

from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
import math
import struct
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageDraw


@dataclass(frozen=True)
class Mesh:
    name: str
    vertices: np.ndarray
    faces: np.ndarray

    def __post_init__(self) -> None:
        vertices = np.asarray(self.vertices, dtype=np.float64)
        faces = np.asarray(self.faces, dtype=np.int64)
        if vertices.ndim != 2 or vertices.shape[1] != 3:
            raise ValueError(f"{self.name}: vertices must have shape (n, 3)")
        if faces.ndim != 2 or faces.shape[1] != 3:
            raise ValueError(f"{self.name}: faces must have shape (n, 3)")
        object.__setattr__(self, "vertices", vertices)
        object.__setattr__(self, "faces", faces)

    @property
    def minimum(self) -> np.ndarray:
        return self.vertices.min(axis=0)

    @property
    def maximum(self) -> np.ndarray:
        return self.vertices.max(axis=0)

    @property
    def dimensions(self) -> np.ndarray:
        return self.maximum - self.minimum

    def transformed(self, matrix: np.ndarray, name: str | None = None) -> "Mesh":
        transform = np.asarray(matrix, dtype=np.float64)
        if transform.shape != (4, 4):
            raise ValueError("transform must have shape (4, 4)")
        homogeneous = np.column_stack((self.vertices, np.ones(len(self.vertices))))
        vertices = (homogeneous @ transform.T)[:, :3]
        return Mesh(name or self.name, vertices, self.faces.copy())

    def translated(self, offset: Sequence[float], name: str | None = None) -> "Mesh":
        matrix = np.eye(4)
        matrix[:3, 3] = np.asarray(offset, dtype=np.float64)
        return self.transformed(matrix, name)

    def rotated_z(self, degrees: float, name: str | None = None) -> "Mesh":
        radians = math.radians(degrees)
        cosine = math.cos(radians)
        sine = math.sin(radians)
        matrix = np.array(
            [
                [cosine, -sine, 0.0, 0.0],
                [sine, cosine, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ]
        )
        return self.transformed(matrix, name)

    def rotated_x(self, degrees: float, name: str | None = None) -> "Mesh":
        radians = math.radians(degrees)
        cosine = math.cos(radians)
        sine = math.sin(radians)
        matrix = np.array(
            [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, cosine, -sine, 0.0],
                [0.0, sine, cosine, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ]
        )
        return self.transformed(matrix, name)

    def centered_for_print(self, name: str | None = None) -> "Mesh":
        center_xy = (self.minimum[:2] + self.maximum[:2]) / 2.0
        return self.translated((-center_xy[0], -center_xy[1], -self.minimum[2]), name)


@dataclass(frozen=True)
class SceneObject:
    mesh: Mesh
    color: tuple[int, int, int]


def merge(name: str, meshes: Iterable[Mesh]) -> Mesh:
    vertices: list[np.ndarray] = []
    faces: list[np.ndarray] = []
    offset = 0
    for mesh in meshes:
        vertices.append(mesh.vertices)
        faces.append(mesh.faces + offset)
        offset += len(mesh.vertices)
    if not vertices:
        raise ValueError(f"{name}: cannot merge an empty mesh list")
    return Mesh(name, np.vstack(vertices), np.vstack(faces))


def box(
    name: str,
    size: Sequence[float],
    center: Sequence[float] = (0.0, 0.0, 0.0),
) -> Mesh:
    sx, sy, sz = (float(value) for value in size)
    if min(sx, sy, sz) <= 0:
        raise ValueError(f"{name}: box dimensions must be positive")
    cx, cy, cz = (float(value) for value in center)
    x0, x1 = cx - sx / 2.0, cx + sx / 2.0
    y0, y1 = cy - sy / 2.0, cy + sy / 2.0
    z0, z1 = cz - sz / 2.0, cz + sz / 2.0
    vertices = np.array(
        [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ]
    )
    faces = np.array(
        [
            [0, 2, 1], [0, 3, 2],
            [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4],
            [3, 7, 6], [3, 6, 2],
            [0, 4, 7], [0, 7, 3],
            [1, 2, 6], [1, 6, 5],
        ]
    )
    return Mesh(name, vertices, faces)


def cylinder(
    name: str,
    radius: float,
    height: float,
    segments: int = 48,
    center: Sequence[float] = (0.0, 0.0, 0.0),
) -> Mesh:
    if radius <= 0 or height <= 0 or segments < 8:
        raise ValueError(f"{name}: invalid cylinder parameters")
    cx, cy, cz = (float(value) for value in center)
    z0, z1 = cz - height / 2.0, cz + height / 2.0
    vertices: list[list[float]] = []
    for z in (z0, z1):
        for index in range(segments):
            angle = 2.0 * math.pi * index / segments
            vertices.append([cx + radius * math.cos(angle), cy + radius * math.sin(angle), z])
    bottom_center = len(vertices)
    vertices.append([cx, cy, z0])
    top_center = len(vertices)
    vertices.append([cx, cy, z1])
    faces: list[list[int]] = []
    for index in range(segments):
        following = (index + 1) % segments
        bottom_i, bottom_j = index, following
        top_i, top_j = segments + index, segments + following
        faces.extend(
            [
                [bottom_i, bottom_j, top_j],
                [bottom_i, top_j, top_i],
                [bottom_center, bottom_j, bottom_i],
                [top_center, top_i, top_j],
            ]
        )
    return Mesh(name, np.asarray(vertices), np.asarray(faces))


def ring(
    name: str,
    outer_radius: float,
    inner_radius: float,
    height: float,
    segments: int = 48,
    center: Sequence[float] = (0.0, 0.0, 0.0),
) -> Mesh:
    return ring_sector(
        name,
        outer_radius,
        inner_radius,
        height,
        0.0,
        360.0,
        segments,
        center,
        close_ends=False,
    )


def ring_sector(
    name: str,
    outer_radius: float,
    inner_radius: float,
    height: float,
    start_deg: float,
    end_deg: float,
    segments: int = 24,
    center: Sequence[float] = (0.0, 0.0, 0.0),
    close_ends: bool = True,
) -> Mesh:
    if not (outer_radius > inner_radius > 0 and height > 0 and segments >= 2):
        raise ValueError(f"{name}: invalid ring-sector parameters")
    cx, cy, cz = (float(value) for value in center)
    z0, z1 = cz - height / 2.0, cz + height / 2.0
    angles = np.linspace(math.radians(start_deg), math.radians(end_deg), segments + 1)
    vertices: list[list[float]] = []
    for z in (z0, z1):
        for angle in angles:
            vertices.append([cx + inner_radius * math.cos(angle), cy + inner_radius * math.sin(angle), z])
            vertices.append([cx + outer_radius * math.cos(angle), cy + outer_radius * math.sin(angle), z])
    layer_count = 2 * len(angles)
    faces: list[list[int]] = []
    for index in range(segments):
        inner_bottom_i = 2 * index
        outer_bottom_i = inner_bottom_i + 1
        inner_bottom_j = inner_bottom_i + 2
        outer_bottom_j = inner_bottom_i + 3
        inner_top_i = layer_count + inner_bottom_i
        outer_top_i = layer_count + outer_bottom_i
        inner_top_j = layer_count + inner_bottom_j
        outer_top_j = layer_count + outer_bottom_j
        faces.extend(
            [
                [outer_bottom_i, outer_bottom_j, outer_top_j],
                [outer_bottom_i, outer_top_j, outer_top_i],
                [inner_bottom_i, inner_top_j, inner_bottom_j],
                [inner_bottom_i, inner_top_i, inner_top_j],
                [inner_top_i, outer_top_i, outer_top_j],
                [inner_top_i, outer_top_j, inner_top_j],
                [inner_bottom_i, outer_bottom_j, outer_bottom_i],
                [inner_bottom_i, inner_bottom_j, outer_bottom_j],
            ]
        )
    if close_ends:
        inner_bottom_start, outer_bottom_start = 0, 1
        inner_top_start, outer_top_start = layer_count, layer_count + 1
        inner_bottom_end, outer_bottom_end = layer_count - 2, layer_count - 1
        inner_top_end, outer_top_end = 2 * layer_count - 2, 2 * layer_count - 1
        faces.extend(
            [
                [inner_bottom_start, outer_bottom_start, outer_top_start],
                [inner_bottom_start, outer_top_start, inner_top_start],
                [inner_bottom_end, inner_top_end, outer_top_end],
                [inner_bottom_end, outer_top_end, outer_bottom_end],
            ]
        )
    return Mesh(name, np.asarray(vertices), np.asarray(faces))


def annular_frustum_sector(
    name: str,
    outer_bottom_radius: float,
    outer_top_radius: float,
    inner_bottom_radius: float,
    inner_top_radius: float,
    height: float,
    start_deg: float,
    end_deg: float,
    segments: int = 24,
    center_z: float = 0.0,
) -> Mesh:
    radii = (outer_bottom_radius, outer_top_radius, inner_bottom_radius, inner_top_radius)
    if min(radii) <= 0 or outer_bottom_radius <= inner_bottom_radius or outer_top_radius <= inner_top_radius:
        raise ValueError(f"{name}: invalid annular-frustum radii")
    if height <= 0 or segments < 2:
        raise ValueError(f"{name}: invalid annular-frustum height or segments")
    z0, z1 = center_z - height / 2.0, center_z + height / 2.0
    angles = np.linspace(math.radians(start_deg), math.radians(end_deg), segments + 1)
    vertices: list[list[float]] = []
    for angle in angles:
        cosine, sine = math.cos(angle), math.sin(angle)
        vertices.extend(
            [
                [inner_bottom_radius * cosine, inner_bottom_radius * sine, z0],
                [outer_bottom_radius * cosine, outer_bottom_radius * sine, z0],
                [inner_top_radius * cosine, inner_top_radius * sine, z1],
                [outer_top_radius * cosine, outer_top_radius * sine, z1],
            ]
        )
    faces: list[list[int]] = []
    for index in range(segments):
        base = 4 * index
        following = base + 4
        inner_bottom_i, outer_bottom_i, inner_top_i, outer_top_i = base, base + 1, base + 2, base + 3
        inner_bottom_j, outer_bottom_j, inner_top_j, outer_top_j = (
            following,
            following + 1,
            following + 2,
            following + 3,
        )
        faces.extend(
            [
                [outer_bottom_i, outer_bottom_j, outer_top_j],
                [outer_bottom_i, outer_top_j, outer_top_i],
                [inner_bottom_i, inner_top_j, inner_bottom_j],
                [inner_bottom_i, inner_top_i, inner_top_j],
                [inner_top_i, outer_top_i, outer_top_j],
                [inner_top_i, outer_top_j, inner_top_j],
                [inner_bottom_i, outer_bottom_j, outer_bottom_i],
                [inner_bottom_i, inner_bottom_j, outer_bottom_j],
            ]
        )
    start = 0
    end = 4 * segments
    faces.extend(
        [
            [start, start + 1, start + 3],
            [start, start + 3, start + 2],
            [end, end + 2, end + 3],
            [end, end + 3, end + 1],
        ]
    )
    return Mesh(name, np.asarray(vertices), np.asarray(faces))


def convex_prism(
    name: str,
    profile: Sequence[Sequence[float]],
    height: float,
    center_z: float = 0.0,
) -> Mesh:
    points = np.asarray(profile, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < 3 or height <= 0:
        raise ValueError(f"{name}: invalid convex-prism parameters")
    z0, z1 = center_z - height / 2.0, center_z + height / 2.0
    vertices = np.vstack(
        (
            np.column_stack((points, np.full(len(points), z0))),
            np.column_stack((points, np.full(len(points), z1))),
        )
    )
    count = len(points)
    faces: list[list[int]] = []
    for index in range(1, count - 1):
        faces.append([0, index + 1, index])
        faces.append([count, count + index, count + index + 1])
    for index in range(count):
        following = (index + 1) % count
        faces.append([index, following, count + following])
        faces.append([index, count + following, count + index])
    return Mesh(name, vertices, np.asarray(faces))


def u_channel(
    name: str,
    length: float,
    outer_width: float,
    height: float,
    wall: float,
) -> Mesh:
    if outer_width <= 2 * wall or height <= wall:
        raise ValueError(f"{name}: U-channel wall is too large")
    return merge(
        name,
        [
            box(f"{name}_floor", (length, outer_width, wall), (0.0, 0.0, wall / 2.0)),
            box(
                f"{name}_left",
                (length, wall, height),
                (0.0, -(outer_width - wall) / 2.0, height / 2.0),
            ),
            box(
                f"{name}_right",
                (length, wall, height),
                (0.0, (outer_width - wall) / 2.0, height / 2.0),
            ),
        ],
    )


def edge_count_validation(mesh: Mesh, tolerance_digits: int = 6) -> dict[str, object]:
    rounded = np.round(mesh.vertices, tolerance_digits)
    unique_vertices, inverse = np.unique(rounded, axis=0, return_inverse=True)
    welded_faces = inverse[mesh.faces]
    triangles = unique_vertices[welded_faces]
    cross_products = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    double_areas = np.linalg.norm(cross_products, axis=1)
    edge_counter: Counter[tuple[int, int]] = Counter()
    adjacency: dict[int, set[int]] = defaultdict(set)
    edge_to_faces: dict[tuple[int, int], list[int]] = defaultdict(list)
    for face_index, face in enumerate(welded_faces):
        for start, end in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])):
            edge = tuple(sorted((int(start), int(end))))
            edge_counter[edge] += 1
            edge_to_faces[edge].append(face_index)
    for face_indices in edge_to_faces.values():
        for face_index in face_indices:
            adjacency[face_index].update(other for other in face_indices if other != face_index)
    visited: set[int] = set()
    component_count = 0
    for face_index in range(len(welded_faces)):
        if face_index in visited:
            continue
        component_count += 1
        queue: deque[int] = deque([face_index])
        visited.add(face_index)
        while queue:
            current = queue.popleft()
            for neighbor in adjacency[current]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)
    # The generated parts intentionally combine multiple closed primitives.
    # Coincident interfaces therefore produce edge multiplicities of 4, 6, ...
    # after coordinate welding.  Odd multiplicity means a real open boundary;
    # even multiplicity above 2 is reported separately as a slicer-union edge.
    open_boundary_edges = sum(1 for count in edge_counter.values() if count % 2 != 0)
    nonmanifold_edges = sum(1 for count in edge_counter.values() if count > 2)
    signed_volume = np.einsum(
        "ij,ij->i",
        triangles[:, 0],
        np.cross(triangles[:, 1], triangles[:, 2]),
    ).sum() / 6.0
    return {
        "vertices": int(len(unique_vertices)),
        "triangles": int(len(welded_faces)),
        "components": int(component_count),
        "degenerate_triangles": int(np.count_nonzero(double_areas < 1e-8)),
        "unmatched_edges": int(open_boundary_edges),
        "open_boundary_edges": int(open_boundary_edges),
        "nonmanifold_union_edges": int(nonmanifold_edges),
        "watertight_by_edges": bool(open_boundary_edges == 0),
        "single_manifold_by_edges": bool(open_boundary_edges == 0 and nonmanifold_edges == 0),
        "signed_volume_mm3": float(signed_volume),
        "dimensions_mm": [round(float(value), 3) for value in mesh.dimensions],
        "minimum_mm": [round(float(value), 3) for value in mesh.minimum],
        "maximum_mm": [round(float(value), 3) for value in mesh.maximum],
    }


def export_binary_stl(mesh: Mesh, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header_text = f"C-problem parametric CAD: {mesh.name}".encode("ascii", "replace")[:80]
    header = header_text.ljust(80, b"\0")
    triangles = mesh.vertices[mesh.faces]
    with path.open("wb") as handle:
        handle.write(header)
        handle.write(struct.pack("<I", len(triangles)))
        for triangle in triangles:
            normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
            magnitude = np.linalg.norm(normal)
            if magnitude > 0:
                normal = normal / magnitude
            values = [*normal, *triangle[0], *triangle[1], *triangle[2]]
            handle.write(struct.pack("<12fH", *(float(value) for value in values), 0))


def load_binary_stl(path: Path, name: str | None = None) -> Mesh:
    data = path.read_bytes()
    if len(data) < 84:
        raise ValueError(f"{path}: invalid binary STL")
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    expected_size = 84 + triangle_count * 50
    if len(data) != expected_size:
        raise ValueError(f"{path}: expected {expected_size} bytes, found {len(data)}")
    vertices: list[list[float]] = []
    faces: list[list[int]] = []
    offset = 84
    for triangle_index in range(triangle_count):
        unpacked = struct.unpack_from("<12fH", data, offset)
        triangle_vertices = [unpacked[3:6], unpacked[6:9], unpacked[9:12]]
        start = len(vertices)
        vertices.extend(triangle_vertices)
        faces.append([start, start + 1, start + 2])
        offset += 50
    return Mesh(name or path.stem, np.asarray(vertices), np.asarray(faces))


def render_scene(
    objects: Sequence[SceneObject],
    path: Path,
    title: str,
    image_size: tuple[int, int] = (1600, 1200),
    azimuth_deg: float = -55.0,
    elevation_deg: float = 32.0,
    padding: int = 90,
) -> None:
    if not objects:
        raise ValueError("cannot render an empty scene")
    azimuth = math.radians(azimuth_deg)
    elevation = math.radians(elevation_deg)
    camera_direction = np.array(
        [
            math.cos(elevation) * math.cos(azimuth),
            math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
        ]
    )
    camera_direction /= np.linalg.norm(camera_direction)
    world_up = np.array([0.0, 0.0, 1.0])
    right = np.cross(world_up, camera_direction)
    if np.linalg.norm(right) < 1e-9:
        right = np.array([1.0, 0.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(camera_direction, right)
    light = np.array([0.35, -0.25, 0.9])
    light /= np.linalg.norm(light)

    projected_sets: list[np.ndarray] = []
    triangle_records: list[tuple[float, np.ndarray, tuple[int, int, int]]] = []
    for scene_object in objects:
        vertices = scene_object.mesh.vertices
        projected = np.column_stack((vertices @ right, vertices @ up))
        projected_sets.append(projected)
        triangles = vertices[scene_object.mesh.faces]
        if len(scene_object.mesh.faces) != len(triangles):
            raise ValueError(f"{scene_object.mesh.name}: face/triangle count mismatch")
        for face, triangle in zip(scene_object.mesh.faces, triangles):
            normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
            magnitude = np.linalg.norm(normal)
            if magnitude <= 1e-10:
                continue
            normal /= magnitude
            brightness = 0.52 + 0.40 * max(0.0, float(normal @ light))
            color = tuple(min(255, max(0, int(channel * brightness))) for channel in scene_object.color)
            depth = float(np.mean(triangle @ camera_direction))
            triangle_records.append((depth, projected[face], color))

    all_projected = np.vstack(projected_sets)
    minimum = all_projected.min(axis=0)
    maximum = all_projected.max(axis=0)
    span = np.maximum(maximum - minimum, 1e-6)
    width, height = image_size
    scale = min((width - 2 * padding) / span[0], (height - 2 * padding - 60) / span[1])
    center = (minimum + maximum) / 2.0

    image = Image.new("RGB", image_size, (246, 247, 249))
    draw = ImageDraw.Draw(image)
    for _, projected_triangle, color in sorted(triangle_records, key=lambda record: record[0]):
        points = []
        for x_value, y_value in projected_triangle:
            x_pixel = width / 2.0 + (x_value - center[0]) * scale
            y_pixel = height / 2.0 - (y_value - center[1]) * scale + 20
            points.append((round(x_pixel, 2), round(y_pixel, 2)))
        draw.polygon(points, fill=color, outline=(60, 66, 74))
    draw.rounded_rectangle((32, 24, width - 32, 74), radius=12, fill=(28, 35, 48))
    draw.text((52, 41), title, fill=(255, 255, 255))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
