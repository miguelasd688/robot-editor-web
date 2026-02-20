export const CARTPOLE_SAMPLE_KEY = "samples/cartpole/Cartpole_robot.urdf";
export const CARTPOLE_SAMPLE_NAME = "Cartpole_robot.urdf";

export function findCartpoleSampleKey(keys: string[]) {
  return (
    keys.find((key) => key === CARTPOLE_SAMPLE_KEY || key.endsWith(`/${CARTPOLE_SAMPLE_NAME}`)) ??
    keys.find((key) => key === CARTPOLE_SAMPLE_NAME) ??
    null
  );
}

export const CARTPOLE_SAMPLE_URDF = `<?xml version="1.0"?>
<robot name="Cartpole_robot">
  <link name="base_link">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0" />
      <mass value="0.0032" />
      <inertia ixx="0.004267" ixy="0" ixz="0" iyy="0.004267" iyz="0" izz="0.000002" />
    </inertial>
    <visual name="Cube">
      <origin xyz="0 0 0" rpy="0 0 0" />
      <geometry>
        <box size="0.02 0.02 4" />
      </geometry>
    </visual>
    <collision name="Cube">
      <origin xyz="0 0 0" rpy="0 0 0" />
      <geometry>
        <box size="0.02 0.02 4" />
      </geometry>
    </collision>
  </link>
  <link name="cart">
    <inertial>
      <origin xyz="0 0 0" rpy="0 0 0" />
      <mass value="0.4608" />
      <inertia ixx="0.001536" ixy="0" ixz="0" iyy="0.001536" iyz="0" izz="0.001106" />
    </inertial>
    <visual name="Cube_1">
      <origin xyz="0 0 0" rpy="0 0 0" />
      <geometry>
        <box size="0.12 0.12 0.16" />
      </geometry>
    </visual>
    <collision name="Cube_1">
      <origin xyz="0 0 0" rpy="0 0 0" />
      <geometry>
        <box size="0.12 0.12 0.16" />
      </geometry>
    </collision>
  </link>
  <link name="pole">
    <inertial>
      <origin xyz="0 0.458362 0" rpy="0 0 0" />
      <mass value="1.222793" />
      <inertia ixx="0.102522" ixy="0" ixz="0" iyy="0.001246" iyz="0" izz="0.102522" />
    </inertial>
    <visual name="Cube_2">
      <origin xyz="0 0.458362 0" rpy="0 0 0" />
      <geometry>
        <box size="0.078192 1 0.078192" />
      </geometry>
    </visual>
    <collision name="Cube_2">
      <origin xyz="0 0.458362 0" rpy="0 0 0" />
      <geometry>
        <box size="0.078192 1 0.078192" />
      </geometry>
    </collision>
  </link>
  <joint name="slider_rail" type="planar">
    <origin xyz="0.000035 0 -0.000008" rpy="0 0 0" />
    <parent link="base_link" />
    <child link="cart" />
    <axis xyz="0 0 1" />
    <limit lower="-1" upper="1" effort="60" velocity="100" />
    <dynamics damping="0.05" friction="0.01" />
  </joint>
  <joint name="free_joint" type="continuous">
    <origin xyz="0.1156 -0.008654 0" rpy="0 0 0" />
    <parent link="cart" />
    <child link="pole" />
    <axis xyz="1 0 0" />
    <limit lower="-180" upper="180" effort="60" velocity="100" />
    <dynamics damping="0.05" friction="0.01" />
  </joint>
</robot>
`;
