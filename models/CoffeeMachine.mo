model CoffeeMachine
  "Lumped electro-thermal CoffeeMachine boiler model for the Casys v1 kit."
  import SI = Modelica.Units.SI;

  parameter SI.Mass waterMass = 0.5 "Water held in the boiler";
  parameter SI.SpecificHeatCapacity waterSpecificHeatCapacity = 4180;
  parameter SI.HeatCapacity boilerHeatCapacity = 500;
  parameter SI.Temperature initialWaterTemperature = 293.15;
  parameter SI.Temperature ambientTemperature = 293.15;
  parameter SI.Power heaterPowerRated = 1500;
  parameter SI.ThermalConductance heatLossConductance = 5;
  parameter SI.Temperature setpointTemperature = 366.15;
  parameter SI.TemperatureDifference hysteresis = 2;

  parameter SI.HeatCapacity totalHeatCapacity =
    waterMass * waterSpecificHeatCapacity + boilerHeatCapacity
    "Lumped water and boiler thermal capacity";

  Modelica.Blocks.Logical.Hysteresis thermostat(
    uLow = setpointTemperature - hysteresis / 2,
    uHigh = setpointTemperature + hysteresis / 2);
  Modelica.Blocks.Logical.Not heaterEnabled;
  Modelica.Blocks.Math.BooleanToReal heaterCommand(realTrue = 1, realFalse = 0);
  Modelica.Blocks.Math.Gain heaterGain(k = heaterPowerRated);

  SI.Temperature waterTemperature(start = initialWaterTemperature, fixed = true);
  output Real waterTemperatureC(unit = "degC");
  output SI.Power heaterPowerW;
  output SI.Energy heaterEnergyJ(start = 0, fixed = true);
  output Real heaterOn(unit = "1");

equation
  // A transparent first-order energy balance is more appropriate here than a
  // heat-port source: this v1 kit models a single lumped boiler/water state.
  // It also avoids an artificial source-temperature initialization constraint.
  der(waterTemperature) =
    (heaterPowerW - heatLossConductance * (waterTemperature - ambientTemperature)) /
    totalHeatCapacity;
  der(heaterEnergyJ) = heaterPowerW;

  thermostat.u = waterTemperature;
  connect(thermostat.y, heaterEnabled.u);
  connect(heaterEnabled.y, heaterCommand.u);
  connect(heaterCommand.y, heaterGain.u);

  waterTemperatureC = waterTemperature - 273.15;
  heaterPowerW = heaterGain.y;
  heaterOn = heaterCommand.y;
end CoffeeMachine;
