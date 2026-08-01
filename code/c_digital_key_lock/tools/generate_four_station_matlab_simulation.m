function generate_four_station_matlab_simulation
%GENERATE_FOUR_STATION_MATLAB_SIMULATION
% Run a reproducible dynamic and Monte Carlo simulation of the frozen
% four-station UWB model.  The forward measurement field is interpolated
% from 27 measured physical-point prototypes.  Noise vectors are bootstrapped
% from 16,931 real 0.8 s rolling-window residuals.

scriptFolder = fileparts(mfilename("fullpath"));
projectRoot = fileparts(fileparts(fileparts(scriptFolder)));
outputFolder = fullfile(projectRoot, "比赛设计", "总体方案", "仿真图", ...
    "四站190mm_20260801");
inputPath = fullfile(outputFolder, "matlab_simulation_input.mat");
if ~isfile(inputPath)
    error("Simulation:MissingInput", ...
        "MATLAB 仿真输入不存在：%s", inputPath);
end
if ~isfolder(outputFolder)
    mkdir(outputFolder);
end

data = load(inputPath);
rng(20260801, "twister");
configureReportStyle();

forwardField = buildForwardField(data);
simulation = simulateDynamicPath(data, forwardField);
gridResult = simulateMonteCarloGrid(data, forwardField);
boundaryResult = simulateBoundaryTransitions(data, forwardField);

figureDynamicMap(simulation, data, outputFolder);
figureDynamicTimeseries(simulation, outputFolder);
figureMonteCarloHeatmaps(gridResult, outputFolder);
figureBoundaryTransitions(boundaryResult, outputFolder);
writeDynamicGif(simulation, data, outputFolder);

summary = buildSummary(simulation, gridResult, boundaryResult, data);
summaryPath = fullfile(outputFolder, "matlab_simulation_summary.json");
fid = fopen(summaryPath, "w", "n", "UTF-8");
if fid < 0
    error("Simulation:SummaryOpen", "无法写入 %s", summaryPath);
end
cleanup = onCleanup(@() fclose(fid));
fwrite(fid, jsonencode(summary), "char");
fprintf("\nMATLAB simulation complete\n");
fprintf("Dynamic distance MAE: %.2f mm, P95: %.2f mm\n", ...
    summary.dynamic.distanceMaeMm, summary.dynamic.distanceP95Mm);
fprintf("Dynamic angle MAE: %.2f deg, P95: %.2f deg\n", ...
    summary.dynamic.angleMaeDeg, summary.dynamic.angleP95Deg);
fprintf("Dynamic zone agreement: %.2f %%\n", ...
    100 * summary.dynamic.zoneAgreement);
fprintf("Outputs: %s\n", outputFolder);
end


function configureReportStyle
fontName = "PingFang SC";
set(groot, "defaultFigureColor", "w");
set(groot, "defaultAxesFontName", fontName);
set(groot, "defaultTextFontName", fontName);
set(groot, "defaultAxesFontSize", 10.5);
set(groot, "defaultAxesLineWidth", 0.8);
set(groot, "defaultAxesBox", "off");
set(groot, "defaultAxesXColor", [0.20 0.25 0.32]);
set(groot, "defaultAxesYColor", [0.20 0.25 0.32]);
set(groot, "defaultLineLineWidth", 1.8);
end


function fields = buildForwardField(data)
center = double(data.prototype_center_mm(:));
angle = double(data.prototype_angle_deg(:));
ranges = double(data.prototype_ranges_mm);
fields = cell(1, 4);
for station = 1:4
    fields{station} = scatteredInterpolant( ...
        center, angle, ranges(:, station), "natural", "nearest");
end
end


function ranges = evaluateForwardField(fields, centerMm, angleDeg)
centerMm = double(centerMm(:));
angleDeg = double(angleDeg(:));
ranges = zeros(numel(centerMm), 4);
for station = 1:4
    ranges(:, station) = fields{station}(centerMm, angleDeg);
end
end


function simulation = simulateDynamicPath(data, fields)
timeS = (0:0.1:42).';
keyTime = [0 6 12 17 22 28 34 42];
keyBoundary = [2000 1700 1180 850 820 1050 1550 2000];
keyAngle = [-35 -24 -8 18 35 26 5 -28];
trueBoundary = interp1(keyTime, keyBoundary, timeS, "pchip");
trueAngle = interp1(keyTime, keyAngle, timeS, "pchip");
trueCenter = trueBoundary + 300;
baseRanges = evaluateForwardField(fields, trueCenter, trueAngle);
noise = correlatedMeasuredNoise(data, trueCenter, trueAngle, 0.78);
measuredRanges = baseRanges + noise;

count = numel(timeS);
estimatedCenter = zeros(count, 1);
estimatedBoundary = zeros(count, 1);
estimatedAngle = zeros(count, 1);
nearestQ = zeros(count, 1);
neighborSpan = zeros(count, 1);
for index = 1:count
    estimate = estimateCurrentModel(measuredRanges(index, :), data);
    estimatedCenter(index) = estimate.centerMm;
    estimatedBoundary(index) = estimate.boundaryMm;
    estimatedAngle(index) = estimate.angleDeg;
    nearestQ(index) = estimate.nearestQ;
    neighborSpan(index) = estimate.neighborSpanMm;
end

trueState = classifyTruthState(trueBoundary);
estimatedState = applyBoundaryStateMachine(estimatedBoundary);
trueX = trueCenter .* sind(trueAngle);
trueY = trueCenter .* cosd(trueAngle);
estimatedX = estimatedCenter .* sind(estimatedAngle);
estimatedY = estimatedCenter .* cosd(estimatedAngle);

simulation = struct( ...
    "timeS", timeS, ...
    "trueBoundaryMm", trueBoundary, ...
    "trueCenterMm", trueCenter, ...
    "trueAngleDeg", trueAngle, ...
    "trueXmm", trueX, ...
    "trueYmm", trueY, ...
    "baseRangesMm", baseRanges, ...
    "measuredRangesMm", measuredRanges, ...
    "estimatedBoundaryMm", estimatedBoundary, ...
    "estimatedCenterMm", estimatedCenter, ...
    "estimatedAngleDeg", estimatedAngle, ...
    "estimatedXmm", estimatedX, ...
    "estimatedYmm", estimatedY, ...
    "nearestQ", nearestQ, ...
    "neighborSpanMm", neighborSpan, ...
    "trueState", trueState, ...
    "estimatedState", estimatedState);
end


function noise = correlatedMeasuredNoise(data, centerMm, angleDeg, alpha)
raw = sampleLocalResiduals(data, centerMm, angleDeg);
count = size(raw, 1);
noise = zeros(size(raw));
noise(1, :) = raw(1, :);
for index = 2:count
    noise(index, :) = alpha * noise(index - 1, :) + ...
        sqrt(1 - alpha^2) * raw(index, :);
end
end


function residuals = sampleLocalResiduals(data, centerMm, angleDeg)
centerMm = double(centerMm(:));
angleDeg = double(angleDeg(:));
noisePool = double(data.noise_residuals_mm);
noiseCenter = double(data.noise_center_mm(:));
noiseAngle = double(data.noise_angle_deg(:));
residuals = zeros(numel(centerMm), 4);
for index = 1:numel(centerMm)
    truthQ = ((noiseCenter - centerMm(index)) / 400).^2 + ...
        ((noiseAngle - angleDeg(index)) / 20).^2;
    minimumQ = min(truthQ);
    candidateIndices = find(truthQ <= minimumQ + 1e-12);
    selected = candidateIndices(randi(numel(candidateIndices)));
    residuals(index, :) = noisePool(selected, :);
end
end


function estimate = estimateCurrentModel(rangesMm, data)
prototypeRanges = double(data.prototype_ranges_mm);
scale = double(data.distance_scale_mm(:)).';
q = sum(((prototypeRanges - double(rangesMm)) ./ scale).^2, 2);
[sortedQ, order] = sort(q, "ascend");
neighborCount = double(data.neighbor_count(1));
order = order(1:neighborCount);
sortedQ = sortedQ(1:neighborCount);
weights = 1 ./ sqrt(max(sortedQ, double(data.q_floor(1))));
weights = weights / sum(weights);

prototypeCenter = double(data.prototype_center_mm(:));
prototypeAngle = double(data.prototype_angle_deg(:));
centerMm = sum(weights .* prototypeCenter(order));
centerMm = min(max(centerMm, double(data.minimum_center_mm(1))), ...
    double(data.maximum_center_mm(1)));
localAngle = sum(weights .* prototypeAngle(order));

angleMean = double(data.angle_mean_mm(:)).';
angleScale = double(data.angle_scale_mm(1));
coefficients = double(data.angle_coefficients(:)).';
features = [1, (double(rangesMm) - angleMean) / angleScale];
angleDeg = features * coefficients.';
angleDeg = min(max(angleDeg, -60), 60);

neighborCenters = prototypeCenter(order);
estimate = struct( ...
    "centerMm", centerMm, ...
    "boundaryMm", max(centerMm - 300, 0), ...
    "angleDeg", angleDeg, ...
    "localAngleDeg", localAngle, ...
    "nearestQ", sortedQ(1), ...
    "neighborSpanMm", max(neighborCenters) - min(neighborCenters));
end


function states = classifyTruthState(boundaryMm)
states = 3 * ones(size(boundaryMm));
states(boundaryMm <= 2000) = 2;
states(boundaryMm <= 1000) = 1;
end


function states = applyBoundaryStateMachine(boundaryMm)
% State numbers: 1 unlock, 2 welcome, 3 sensing/locked.
state = 3;
candidate = state;
candidateCount = 0;
states = zeros(size(boundaryMm));
for index = 1:numel(boundaryMm)
    value = boundaryMm(index);
    if state == 1
        if value <= 1050
            target = 1;
        elseif value <= 2050
            target = 2;
        else
            target = 3;
        end
    elseif state == 2
        if value <= 1000
            target = 1;
        elseif value <= 2050
            target = 2;
        else
            target = 3;
        end
    else
        if value <= 1000
            target = 1;
        elseif value <= 2000
            target = 2;
        else
            target = 3;
        end
    end

    if target == state
        candidate = state;
        candidateCount = 0;
    elseif target ~= candidate
        candidate = target;
        candidateCount = 1;
    else
        candidateCount = candidateCount + 1;
        if candidateCount >= 3
            state = target;
            candidate = state;
            candidateCount = 0;
        end
    end
    states(index) = state;
end
end


function result = simulateMonteCarloGrid(data, fields)
boundaryGrid = [800 1000 1200 1800 2000];
angleGrid = [-45 -30 -15 0 15 30 45];
trialCount = 400;
distanceP95 = zeros(numel(boundaryGrid), numel(angleGrid));
angleP95 = zeros(size(distanceP95));
distanceMae = zeros(size(distanceP95));
angleMae = zeros(size(distanceP95));
zoneAgreement = zeros(size(distanceP95));

for row = 1:numel(boundaryGrid)
    for column = 1:numel(angleGrid)
        center = boundaryGrid(row) + 300;
        angle = angleGrid(column);
        baseRanges = evaluateForwardField(fields, center, angle);
        localNoise = sampleLocalResiduals( ...
            data, repmat(center, trialCount, 1), ...
            repmat(angle, trialCount, 1));
        measured = baseRanges + localNoise;
        distanceError = zeros(trialCount, 1);
        angleError = zeros(trialCount, 1);
        predictedZone = zeros(trialCount, 1);
        for trial = 1:trialCount
            estimate = estimateCurrentModel(measured(trial, :), data);
            distanceError(trial) = abs(estimate.boundaryMm - boundaryGrid(row));
            angleError(trial) = abs(estimate.angleDeg - angle);
            predictedZone(trial) = classifyTruthState(estimate.boundaryMm);
        end
        truthZone = classifyTruthState(boundaryGrid(row));
        distanceP95(row, column) = percentileLocal(distanceError, 95);
        angleP95(row, column) = percentileLocal(angleError, 95);
        distanceMae(row, column) = mean(distanceError);
        angleMae(row, column) = mean(angleError);
        zoneAgreement(row, column) = mean(predictedZone == truthZone);
    end
end

result = struct( ...
    "boundaryGridMm", boundaryGrid, ...
    "angleGridDeg", angleGrid, ...
    "trialCount", trialCount, ...
    "distanceP95Mm", distanceP95, ...
    "angleP95Deg", angleP95, ...
    "distanceMaeMm", distanceMae, ...
    "angleMaeDeg", angleMae, ...
    "zoneAgreement", zoneAgreement);
end


function result = simulateBoundaryTransitions(data, fields)
trialCount = 220;
frameCount = 5;
angles = [-30 0 30];
thresholds = [1000 2000];
exitThresholds = [1050 2050];
distanceSweeps = {
    linspace(780, 1220, 89), ...
    linspace(1780, 2220, 89)};
entryProbability = cell(1, 2);
exitProbability = cell(1, 2);

for boundaryIndex = 1:2
    sweep = distanceSweeps{boundaryIndex};
    entry = zeros(size(sweep));
    exit = zeros(size(sweep));
    for pointIndex = 1:numel(sweep)
        entered = 0;
        exited = 0;
        for trial = 1:trialCount
            angle = angles(randi(numel(angles)));
            base = evaluateForwardField(fields, sweep(pointIndex) + 300, angle);
            localNoise = sampleLocalResiduals( ...
                data, repmat(sweep(pointIndex) + 300, frameCount, 1), ...
                repmat(angle, frameCount, 1));
            measured = base + localNoise;
            predictedBoundary = zeros(frameCount, 1);
            for frame = 1:frameCount
                estimate = estimateCurrentModel(measured(frame, :), data);
                predictedBoundary(frame) = estimate.boundaryMm;
            end
            if boundaryIndex == 1
                entryStates = applyStateMachineFromState(predictedBoundary, 2);
                exitStates = applyStateMachineFromState(predictedBoundary, 1);
                entered = entered + (entryStates(end) == 1);
                exited = exited + (exitStates(end) ~= 1);
            else
                entryStates = applyStateMachineFromState(predictedBoundary, 3);
                exitStates = applyStateMachineFromState(predictedBoundary, 2);
                entered = entered + (entryStates(end) ~= 3);
                exited = exited + (exitStates(end) == 3);
            end
        end
        entry(pointIndex) = entered / trialCount;
        exit(pointIndex) = exited / trialCount;
    end
    entryProbability{boundaryIndex} = entry;
    exitProbability{boundaryIndex} = exit;
end

result = struct( ...
    "thresholdsMm", thresholds, ...
    "exitThresholdsMm", exitThresholds, ...
    "distanceSweepsMm", {distanceSweeps}, ...
    "entryProbability", {entryProbability}, ...
    "exitProbability", {exitProbability}, ...
    "trialCount", trialCount, ...
    "frameCount", frameCount);
end


function states = applyStateMachineFromState(boundaryMm, initialState)
state = initialState;
candidate = state;
candidateCount = 0;
states = zeros(size(boundaryMm));
for index = 1:numel(boundaryMm)
    value = boundaryMm(index);
    if state == 1
        if value <= 1050
            target = 1;
        elseif value <= 2050
            target = 2;
        else
            target = 3;
        end
    elseif state == 2
        if value <= 1000
            target = 1;
        elseif value <= 2050
            target = 2;
        else
            target = 3;
        end
    else
        if value <= 1000
            target = 1;
        elseif value <= 2000
            target = 2;
        else
            target = 3;
        end
    end
    if target == state
        candidate = state;
        candidateCount = 0;
    elseif target ~= candidate
        candidate = target;
        candidateCount = 1;
    else
        candidateCount = candidateCount + 1;
        if candidateCount >= 3
            state = target;
            candidate = state;
            candidateCount = 0;
        end
    end
    states(index) = state;
end
end


function figureDynamicMap(simulation, data, outputFolder)
figureHandle = figure("Visible", "off", "Position", [80 80 1500 900]);
layout = tiledlayout(figureHandle, 1, 2, ...
    "TileSpacing", "compact", "Padding", "compact");

mapAxes = nexttile(layout, 1);
drawCompetitionMap(mapAxes, 3300, true, data.station_xy_mm);
plot(mapAxes, simulation.trueXmm / 1000, simulation.trueYmm / 1000, ...
    "Color", [0.08 0.25 0.42], "LineWidth", 3.0, ...
    "DisplayName", "真实轨迹");
plot(mapAxes, simulation.estimatedXmm / 1000, ...
    simulation.estimatedYmm / 1000, ...
    "Color", [0.88 0.38 0.12], "LineWidth", 1.8, ...
    "DisplayName", "模型估计轨迹");
connectorIndices = 1:25:numel(simulation.timeS);
for index = connectorIndices
    plot(mapAxes, ...
        [simulation.trueXmm(index) simulation.estimatedXmm(index)] / 1000, ...
        [simulation.trueYmm(index) simulation.estimatedYmm(index)] / 1000, ...
        ":", "Color", [0.45 0.50 0.56], "LineWidth", 0.8, ...
        "HandleVisibility", "off");
end
scatter(mapAxes, simulation.trueXmm(1) / 1000, ...
    simulation.trueYmm(1) / 1000, 90, [0.08 0.45 0.65], "filled", ...
    "DisplayName", "起点");
scatter(mapAxes, simulation.trueXmm(end) / 1000, ...
    simulation.trueYmm(end) / 1000, 110, [0.42 0.27 0.62], "filled", ...
    "DisplayName", "终点");
legend(mapAxes, "Location", "southwest", "NumColumns", 2);
title(mapAxes, "官方比赛地图上的动态进出轨迹");

metricAxes = nexttile(layout, 2);
hold(metricAxes, "on");
distanceError = abs(simulation.estimatedBoundaryMm - simulation.trueBoundaryMm);
angleError = abs(simulation.estimatedAngleDeg - simulation.trueAngleDeg);
scatter(metricAxes, distanceError, angleError, 24, simulation.timeS, ...
    "filled", "MarkerFaceAlpha", 0.72);
xlabel(metricAxes, "边界距离绝对误差 / mm");
ylabel(metricAxes, "方位角绝对误差 / °");
grid(metricAxes, "on");
box(metricAxes, "on");
metricColorbar = colorbar(metricAxes);
metricColorbar.Label.String = "时间 / s";
title(metricAxes, "逐帧距离—角度误差");

distanceMae = mean(distanceError);
distanceP95 = percentileLocal(distanceError, 95);
angleMae = mean(angleError);
angleP95 = percentileLocal(angleError, 95);
zoneAgreement = mean(simulation.trueState == simulation.estimatedState);
metricText = sprintf("Monte Carlo 动态仿真\n距离 MAE  %.1f mm\n" + ...
    "距离 P95  %.1f mm\n角度 MAE  %.1f°\n角度 P95  %.1f°\n" + ...
    "区域一致率 %.1f%%", distanceMae, distanceP95, angleMae, angleP95, ...
    100 * zoneAgreement);
text(metricAxes, 0.04, 0.96, metricText, ...
    "Units", "normalized", "VerticalAlignment", "top", ...
    "FontSize", 12, "FontWeight", "bold", ...
    "BackgroundColor", [1 1 1 0.94], "EdgeColor", [0.75 0.80 0.86], ...
    "Margin", 10);

title(layout, { ...
    "四站 UWB 当前模型动态仿真", ...
    "27 点实测前向场 + 16,931 个滚动窗口残差抽样；随机种子 20260801"}, ...
    "FontSize", 17, "FontWeight", "bold");
exportFigureSet(figureHandle, outputFolder, ...
    "11_matlab_dynamic_trajectory_simulation");
close(figureHandle);
end


function figureDynamicTimeseries(simulation, outputFolder)
figureHandle = figure("Visible", "off", "Position", [90 90 1500 1000]);
layout = tiledlayout(figureHandle, 3, 1, ...
    "TileSpacing", "compact", "Padding", "compact");

distanceAxes = nexttile(layout, 1);
hold(distanceAxes, "on");
shadeDistanceZones(distanceAxes, simulation.timeS([1 end]), [650 2150]);
plot(distanceAxes, simulation.timeS, simulation.trueBoundaryMm, ...
    "Color", [0.08 0.25 0.42], "LineWidth", 2.7, ...
    "DisplayName", "真实边界距离");
plot(distanceAxes, simulation.timeS, simulation.estimatedBoundaryMm, ...
    "Color", [0.88 0.38 0.12], "LineWidth", 1.7, ...
    "DisplayName", "连续距离输出");
yline(distanceAxes, 1000, "--", "1 m 开锁", ...
    "Color", [0.58 0.12 0.18], "LabelHorizontalAlignment", "left", ...
    "HandleVisibility", "off");
yline(distanceAxes, 2000, "--", "2 m 迎宾", ...
    "Color", [0.18 0.43 0.60], "LabelHorizontalAlignment", "left", ...
    "HandleVisibility", "off");
ylabel(distanceAxes, "边界距离 / mm");
grid(distanceAxes, "on");
legend(distanceAxes, "Location", "northeast", "NumColumns", 2);
title(distanceAxes, "双输出一：连续距离估计");

angleAxes = nexttile(layout, 2);
hold(angleAxes, "on");
plot(angleAxes, simulation.timeS, simulation.trueAngleDeg, ...
    "Color", [0.08 0.25 0.42], "LineWidth", 2.7, ...
    "DisplayName", "真实角度");
plot(angleAxes, simulation.timeS, simulation.estimatedAngleDeg, ...
    "Color", [0.88 0.38 0.12], "LineWidth", 1.7, ...
    "DisplayName", "模型角度");
yline(angleAxes, 45, ":", "+45°", "Color", [0.45 0.50 0.56], ...
    "HandleVisibility", "off");
yline(angleAxes, -45, ":", "-45°", "Color", [0.45 0.50 0.56], ...
    "HandleVisibility", "off");
ylabel(angleAxes, "方位角 / °");
grid(angleAxes, "on");
legend(angleAxes, "Location", "northeast", "NumColumns", 2);
title(angleAxes, "四站角度估计（FRONT=+y，右侧为正）");

stateAxes = nexttile(layout, 3);
hold(stateAxes, "on");
stairs(stateAxes, simulation.timeS, simulation.trueState, ...
    "Color", [0.08 0.25 0.42], "LineWidth", 2.7, ...
    "DisplayName", "真实区域");
stairs(stateAxes, simulation.timeS, simulation.estimatedState, ...
    "Color", [0.70 0.20 0.24], "LineWidth", 1.8, ...
    "DisplayName", "边界专项输出（迟滞+3帧确认）");
yticks(stateAxes, [1 2 3]);
yticklabels(stateAxes, ["开锁区" "迎宾区" "感应区/闭锁"]);
ylim(stateAxes, [0.6 3.4]);
xlabel(stateAxes, "时间 / s");
ylabel(stateAxes, "状态");
grid(stateAxes, "on");
legend(stateAxes, "Location", "northeast", "NumColumns", 2);
title(stateAxes, "双输出二：1 m / 2 m 边界专项状态");

title(layout, { ...
    "动态进入—开锁—离开仿真时序", ...
    "0.1 s 模型步长；屏幕可按 0.5 s 节拍抽样显示"}, ...
    "FontSize", 17, "FontWeight", "bold");
exportFigureSet(figureHandle, outputFolder, ...
    "12_matlab_dynamic_distance_angle_state");
close(figureHandle);
end


function figureMonteCarloHeatmaps(result, outputFolder)
figureHandle = figure("Visible", "off", "Position", [100 100 1540 720]);
layout = tiledlayout(figureHandle, 1, 2, ...
    "TileSpacing", "compact", "Padding", "compact");

distanceAxes = nexttile(layout, 1);
drawAnnotatedHeatmap(distanceAxes, result.angleGridDeg, ...
    result.boundaryGridMm, result.distanceP95Mm, ...
    "径向绝对误差 P95 / mm", "mm", "parula");

angleAxes = nexttile(layout, 2);
drawAnnotatedHeatmap(angleAxes, result.angleGridDeg, ...
    result.boundaryGridMm, result.angleP95Deg, ...
    "方位角绝对误差 P95 / °", "°", "turbo");

title(layout, { ...
    sprintf("静态网格 Monte Carlo 仿真（每格 %d 次）", result.trialCount), ...
    "前向场来自 27 个实测点自然邻域插值；噪声来自 16,931 个实测滚动窗口残差"}, ...
    "FontSize", 17, "FontWeight", "bold");
exportFigureSet(figureHandle, outputFolder, ...
    "13_matlab_monte_carlo_error_heatmaps");
close(figureHandle);
end


function figureBoundaryTransitions(result, outputFolder)
figureHandle = figure("Visible", "off", "Position", [100 100 1500 720]);
layout = tiledlayout(figureHandle, 1, 2, ...
    "TileSpacing", "compact", "Padding", "compact");

labels = ["1 m 开锁边界", "2 m 迎宾边界"];
colors = [0.62 0.15 0.20; 0.15 0.43 0.62];
for boundaryIndex = 1:2
    axesHandle = nexttile(layout, boundaryIndex);
    hold(axesHandle, "on");
    sweep = result.distanceSweepsMm{boundaryIndex};
    threshold = result.thresholdsMm(boundaryIndex);
    exitThreshold = result.exitThresholdsMm(boundaryIndex);
    if boundaryIndex == 2
        validMask = sweep <= threshold;
        plot(axesHandle, sweep(validMask), ...
            result.entryProbability{boundaryIndex}(validMask), ...
            "Color", colors(boundaryIndex, :), "LineWidth", 2.5, ...
            "DisplayName", "阈值内进入迎宾状态概率");
        patch(axesHandle, ...
            [threshold max(sweep) max(sweep) threshold], ...
            [0 0 1 1], [0.90 0.92 0.95], ...
            "FaceAlpha", 0.82, "EdgeColor", "none", ...
            "HandleVisibility", "off");
        xline(axesHandle, threshold, ":", "2.00 m 标定上边界", ...
            "Color", colors(boundaryIndex, :), ...
            "LabelVerticalAlignment", "bottom", ...
            "HandleVisibility", "off");
        limitationText = sprintf("2 m 外侧没有实测标定点\n" + ...
            "当前连续边界距离上限 = 2000 mm\n" + ...
            "因此不报告外侧退出概率");
        text(axesHandle, threshold + 0.52 * (max(sweep) - threshold), 0.54, ...
            limitationText, ...
            "HorizontalAlignment", "center", "VerticalAlignment", "middle", ...
            "FontSize", 12, "FontWeight", "bold", ...
            "Color", [0.32 0.37 0.44], ...
            "BackgroundColor", [1 1 1 0.88], ...
            "EdgeColor", [0.72 0.76 0.82], "Margin", 9);
        ylim(axesHandle, [-0.03 1.03]);
        xlim(axesHandle, [min(sweep) max(sweep)]);
        xlabel(axesHandle, "真实边界距离 / mm");
        ylabel(axesHandle, "5 帧后状态切换概率");
        grid(axesHandle, "on");
        legend(axesHandle, "Location", "southwest");
        title(axesHandle, "2 m 迎宾边界：外侧数据不足，不作性能结论");
        continue;
    end
    patch(axesHandle, ...
        [threshold exitThreshold exitThreshold threshold], ...
        [0 0 1 1], [0.95 0.84 0.60], ...
        "FaceAlpha", 0.35, "EdgeColor", "none", ...
        "DisplayName", "迟滞带");
    plot(axesHandle, sweep, result.entryProbability{boundaryIndex}, ...
        "Color", colors(boundaryIndex, :), "LineWidth", 2.5, ...
        "DisplayName", "从外侧进入后成功切换概率");
    plot(axesHandle, sweep, result.exitProbability{boundaryIndex}, ...
        "--", "Color", [0.26 0.31 0.39], "LineWidth", 2.2, ...
        "DisplayName", "从内侧退出后成功切换概率");
    xline(axesHandle, threshold, ":", sprintf("进入 %.2f m", threshold / 1000), ...
        "Color", colors(boundaryIndex, :), ...
        "LabelVerticalAlignment", "bottom", ...
        "HandleVisibility", "off");
    xline(axesHandle, exitThreshold, ":", ...
        sprintf("退出 %.2f m", exitThreshold / 1000), ...
        "Color", [0.26 0.31 0.39], ...
        "LabelVerticalAlignment", "top", ...
        "HandleVisibility", "off");
    ylim(axesHandle, [-0.03 1.03]);
    xlabel(axesHandle, "真实边界距离 / mm");
    ylabel(axesHandle, "5 帧后状态切换概率");
    grid(axesHandle, "on");
    legend(axesHandle, "Location", "best");
    title(axesHandle, labels(boundaryIndex));
end

title(layout, { ...
    "当前双输出模型：1 m 边界 Monte Carlo 仿真与 2 m 数据边界", ...
    sprintf("迟滞 50 mm，连续 3 帧确认；每个距离点 %d 次、每次 %d 帧", ...
    result.trialCount, result.frameCount)}, ...
    "FontSize", 17, "FontWeight", "bold");
exportFigureSet(figureHandle, outputFolder, ...
    "14_matlab_dual_output_boundary_simulation");
close(figureHandle);
end


function drawCompetitionMap(axesHandle, maxCenterMm, showLabels, stationXY)
hold(axesHandle, "on");
zoneColors = struct( ...
    "unlock", [248 215 218] / 255, ...
    "welcome", [255 241 204] / 255, ...
    "sensing", [220 238 248] / 255, ...
    "lock", [233 238 245] / 255, ...
    "edge", [47 58 69] / 255, ...
    "ray", [100 116 139] / 255);
drawAnnularSector(axesHandle, 300, 1300, zoneColors.unlock);
drawAnnularSector(axesHandle, 1300, 2300, zoneColors.welcome);
drawAnnularSector(axesHandle, 2300, maxCenterMm, zoneColors.sensing);

theta = linspace(0, 2 * pi, 240);
patch(axesHandle, 0.3 * cos(theta), 0.3 * sin(theta), ...
    zoneColors.lock, "EdgeColor", zoneColors.edge, "LineWidth", 1.5, ...
    "HandleVisibility", "off");

angleValues = -45:15:45;
for angle = angleValues
    startXY = [300 * sind(angle), 300 * cosd(angle)] / 1000;
    endXY = [maxCenterMm * sind(angle), maxCenterMm * cosd(angle)] / 1000;
    if any(angle == [-45 0 45])
        lineStyle = "-";
        lineWidth = 1.15;
    else
        lineStyle = "--";
        lineWidth = 0.8;
    end
    plot(axesHandle, [startXY(1) endXY(1)], ...
        [startXY(2) endXY(2)], lineStyle, ...
        "Color", zoneColors.ray, "LineWidth", lineWidth, ...
        "HandleVisibility", "off");
    labelXY = [maxCenterMm * 1.025 * sind(angle), ...
        maxCenterMm * 1.025 * cosd(angle)] / 1000;
    text(axesHandle, labelXY(1), labelXY(2), sprintf("%+d°", angle), ...
        "HorizontalAlignment", "center", "VerticalAlignment", "middle", ...
        "Color", zoneColors.edge, "FontSize", 9);
end

if showLabels
    text(axesHandle, 0, 0.78, "开锁区 0–1 m", ...
        "HorizontalAlignment", "center", "FontWeight", "bold", ...
        "Color", [0.48 0.10 0.14], "BackgroundColor", [1 1 1 0.78]);
    text(axesHandle, 0, 1.78, "迎宾区 1–2 m", ...
        "HorizontalAlignment", "center", "FontWeight", "bold", ...
        "Color", [0.48 0.34 0.06], "BackgroundColor", [1 1 1 0.78]);
    text(axesHandle, 0, 2.78, "感应区 >2 m", ...
        "HorizontalAlignment", "center", "FontWeight", "bold", ...
        "Color", [0.10 0.36 0.52], "BackgroundColor", [1 1 1 0.78]);
end

stationXY = double(stationXY);
scatter(axesHandle, stationXY(:, 1) / 1000, stationXY(:, 2) / 1000, ...
    46, [0.70 0.16 0.18], "s", "filled", ...
    "MarkerEdgeColor", "w", "LineWidth", 0.7, ...
    "DisplayName", "四个 UWB 基站");
text(axesHandle, 0, -0.02, "智能门锁", ...
    "HorizontalAlignment", "center", "VerticalAlignment", "middle", ...
    "FontWeight", "bold", "Color", zoneColors.edge);
quiver(axesHandle, 0, 0.18, 0, 0.33, 0, ...
    "Color", zoneColors.edge, "LineWidth", 1.4, ...
    "MaxHeadSize", 0.7, "HandleVisibility", "off");
text(axesHandle, 0.04, 0.52, "FRONT +y", ...
    "Color", zoneColors.edge, "FontWeight", "bold");

axis(axesHandle, "equal");
xlim(axesHandle, [-2.55 2.55]);
ylim(axesHandle, [-0.38 3.52]);
xlabel(axesHandle, "横向 x / m（右为正）");
ylabel(axesHandle, "前向 y / m");
grid(axesHandle, "off");
box(axesHandle, "on");
end


function drawAnnularSector(axesHandle, innerMm, outerMm, color)
angle = linspace(-45, 45, 241);
outerX = outerMm * sind(angle) / 1000;
outerY = outerMm * cosd(angle) / 1000;
innerX = innerMm * sind(fliplr(angle)) / 1000;
innerY = innerMm * cosd(fliplr(angle)) / 1000;
patch(axesHandle, [outerX innerX], [outerY innerY], color, ...
    "EdgeColor", [47 58 69] / 255, "LineWidth", 1.1, ...
    "HandleVisibility", "off");
end


function shadeDistanceZones(axesHandle, timeLimits, distanceLimits)
hold(axesHandle, "on");
timeLimits = reshape(timeLimits, 1, []);
timePolygon = [timeLimits(1) timeLimits(2) timeLimits(2) timeLimits(1)];
patch(axesHandle, timePolygon, ...
    [distanceLimits(1) distanceLimits(1) 1000 1000], ...
    [248 215 218] / 255, "EdgeColor", "none", ...
    "FaceAlpha", 0.58, "HandleVisibility", "off");
patch(axesHandle, timePolygon, ...
    [1000 1000 2000 2000], [255 241 204] / 255, ...
    "EdgeColor", "none", "FaceAlpha", 0.50, ...
    "HandleVisibility", "off");
patch(axesHandle, timePolygon, ...
    [2000 2000 distanceLimits(2) distanceLimits(2)], ...
    [220 238 248] / 255, "EdgeColor", "none", ...
    "FaceAlpha", 0.58, "HandleVisibility", "off");
xlim(axesHandle, timeLimits);
ylim(axesHandle, distanceLimits);
end


function drawAnnotatedHeatmap(axesHandle, xValues, yValues, matrix, ...
    titleText, unitText, colorMapName)
imagesc(axesHandle, xValues, yValues, matrix);
set(axesHandle, "YDir", "normal");
colormap(axesHandle, colorMapName);
heatmapColorbar = colorbar(axesHandle);
heatmapColorbar.Label.String = titleText;
xticks(axesHandle, xValues);
yticks(axesHandle, yValues);
xlabel(axesHandle, "真实方位角 / °");
ylabel(axesHandle, "真实边界距离 / mm");
title(axesHandle, titleText);
finiteValues = matrix(isfinite(matrix));
threshold = mean(finiteValues);
for row = 1:size(matrix, 1)
    for column = 1:size(matrix, 2)
        if matrix(row, column) > threshold
            textColor = "w";
        else
            textColor = [0.08 0.11 0.15];
        end
        text(axesHandle, xValues(column), yValues(row), ...
            sprintf("%.1f %s", matrix(row, column), unitText), ...
            "HorizontalAlignment", "center", ...
            "VerticalAlignment", "middle", ...
            "Color", textColor, "FontWeight", "bold", "FontSize", 9);
    end
end
box(axesHandle, "on");
end


function writeDynamicGif(simulation, data, outputFolder)
gifPath = fullfile(outputFolder, ...
    "11_matlab_dynamic_trajectory_simulation.gif");
frameIndices = unique(round(linspace(1, numel(simulation.timeS), 72)));
figureHandle = figure("Visible", "off", "Position", [80 80 1000 760]);
axesHandle = axes(figureHandle);
temporaryPng = fullfile(tempdir, ...
    sprintf("uwb_matlab_sim_%d.png", feature("getpid")));
for frameNumber = 1:numel(frameIndices)
    index = frameIndices(frameNumber);
    cla(axesHandle);
    drawCompetitionMap(axesHandle, 3300, true, data.station_xy_mm);
    plot(axesHandle, simulation.trueXmm(1:index) / 1000, ...
        simulation.trueYmm(1:index) / 1000, ...
        "Color", [0.08 0.25 0.42], "LineWidth", 2.8, ...
        "DisplayName", "真实轨迹");
    plot(axesHandle, simulation.estimatedXmm(1:index) / 1000, ...
        simulation.estimatedYmm(1:index) / 1000, ...
        "Color", [0.88 0.38 0.12], "LineWidth", 1.7, ...
        "DisplayName", "模型估计");
    scatter(axesHandle, simulation.trueXmm(index) / 1000, ...
        simulation.trueYmm(index) / 1000, 100, ...
        [0.03 0.50 0.55], "*", "LineWidth", 1.5, ...
        "DisplayName", "当前真值");
    scatter(axesHandle, simulation.estimatedXmm(index) / 1000, ...
        simulation.estimatedYmm(index) / 1000, 70, ...
        [0.88 0.38 0.12], "filled", ...
        "MarkerEdgeColor", [0.35 0.13 0.08], ...
        "DisplayName", "当前估计");
    frameTitle = sprintf("四站 UWB 模型动态仿真  t = %.1f s\n" + ...
        "真值 d = %.2f m, α = %.1f°；估计 d = %.2f m, α = %.1f°", ...
        simulation.timeS(index), simulation.trueBoundaryMm(index) / 1000, ...
        simulation.trueAngleDeg(index), ...
        simulation.estimatedBoundaryMm(index) / 1000, ...
        simulation.estimatedAngleDeg(index));
    title(axesHandle, frameTitle, "FontWeight", "bold");
    legend(axesHandle, "Location", "southwest", "NumColumns", 2);
    exportgraphics(figureHandle, temporaryPng, "Resolution", 115);
    rgb = imread(temporaryPng);
    [indexed, map] = rgb2ind(rgb, 256);
    if frameNumber == 1
        imwrite(indexed, map, gifPath, "gif", ...
            "LoopCount", inf, "DelayTime", 0.10);
    else
        imwrite(indexed, map, gifPath, "gif", ...
            "WriteMode", "append", "DelayTime", 0.10);
    end
end
if isfile(temporaryPng)
    delete(temporaryPng);
end
close(figureHandle);
end


function exportFigureSet(figureHandle, outputFolder, stem)
exportgraphics(figureHandle, fullfile(outputFolder, stem + ".png"), ...
    "Resolution", 300);
exportgraphics(figureHandle, fullfile(outputFolder, stem + ".pdf"), ...
    "ContentType", "vector");
exportgraphics(figureHandle, fullfile(outputFolder, stem + ".svg"), ...
    "ContentType", "vector");
end


function value = percentileLocal(values, percentile)
values = sort(double(values(:)));
if isempty(values)
    value = NaN;
    return;
end
position = 1 + (numel(values) - 1) * percentile / 100;
lowerIndex = floor(position);
upperIndex = ceil(position);
if lowerIndex == upperIndex
    value = values(lowerIndex);
else
    fraction = position - lowerIndex;
    value = values(lowerIndex) * (1 - fraction) + ...
        values(upperIndex) * fraction;
end
end


function summary = buildSummary(simulation, gridResult, boundaryResult, data)
distanceError = abs(simulation.estimatedBoundaryMm - simulation.trueBoundaryMm);
angleError = abs(simulation.estimatedAngleDeg - simulation.trueAngleDeg);
summary = struct;
summary.reportType = "MATLAB Monte Carlo model simulation";
summary.generatedAt = char(datetime("now", "TimeZone", "Asia/Shanghai", ...
    "Format", "yyyy-MM-dd'T'HH:mm:ssXXX"));
summary.randomSeed = 20260801;
summary.source = struct( ...
    "modelId", string(data.source_model_id(1)), ...
    "physicalPointCount", double(data.source_physical_point_count(1)), ...
    "captureCount", double(data.source_capture_count(1)), ...
    "rollingResidualCount", size(data.noise_residuals_mm, 1), ...
    "forwardField", "scatteredInterpolant natural/nearest", ...
    "noiseModel", "measured 0.8 s rolling residual bootstrap");
summary.dynamic = struct( ...
    "frameCount", numel(simulation.timeS), ...
    "stepSeconds", simulation.timeS(2) - simulation.timeS(1), ...
    "distanceMaeMm", mean(distanceError), ...
    "distanceP95Mm", percentileLocal(distanceError, 95), ...
    "distanceMaxMm", max(distanceError), ...
    "angleMaeDeg", mean(angleError), ...
    "angleP95Deg", percentileLocal(angleError, 95), ...
    "angleMaxDeg", max(angleError), ...
    "zoneAgreement", mean(simulation.trueState == simulation.estimatedState));
summary.monteCarloGrid = struct( ...
    "trialCountPerCell", gridResult.trialCount, ...
    "boundaryGridMm", gridResult.boundaryGridMm, ...
    "angleGridDeg", gridResult.angleGridDeg, ...
    "distanceP95Mm", gridResult.distanceP95Mm, ...
    "angleP95Deg", gridResult.angleP95Deg, ...
    "zoneAgreement", gridResult.zoneAgreement);
summary.dualOutputBoundary = struct( ...
    "trialCountPerDistance", boundaryResult.trialCount, ...
    "framesPerTrial", boundaryResult.frameCount, ...
    "entryThresholdsMm", boundaryResult.thresholdsMm, ...
    "exitThresholdsMm", boundaryResult.exitThresholdsMm, ...
    "confirmationFrames", 3);
summary.scopeNote = [ ...
    "仿真仅覆盖当前标定流形（边界距离约 0.8–2.0 m、角度 ±45°）。" ...
    "比赛地图 >2 m 感应区已绘制，但没有把外推结果当成已验证性能。"];
end
