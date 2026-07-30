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

  Modelica.Thermal.HeatTransfer.Components.HeatCapacitor water(
    C = waterMass * waterSpecificHeatCapacity + boilerHeatCapacity,
    T(start = initialWaterTemperature, fixed = true));
  Modelica.Thermal.HeatTransfer.Components.ThermalConductor losses(
    G = heatLossConductance);
  Modelica.Thermal.HeatTransfer.Sources.FixedTemperature ambient(
    T = ambientTemperature);
  Modelica.Thermal.HeatTransfer.Sources.PrescribedHeatFlow heater;
  Modelica.Blocks.Logical.Hysteresis thermostat(
    uLow = setpointTemperature - hysteresis / 2,
    uHigh = setpointTemperature + hysteresis / 2);
  Modelica.Blocks.Logical.Not heaterEnabled;
  Modelica.Blocks.Math.BooleanToReal heaterCommand(realTrue = 1, realFalse = 0);
  Modelica.Blocks.Math.Gain heaterGain(k = heaterPowerRated);
  Modelica.Blocks.Continuous.Integrator heaterEnergy(y_start = 0);

  output Real waterTemperatureC(unit = "degC");
  output SI.Power heaterPowerW;
  output SI.Energy heaterEnergyJ;
  output Real heaterOn(unit = "1");

equation
  connect(water.port, losses.port_a);
  connect(losses.port_b, ambient.port);
  thermostat.u = water.T;
  connect(thermostat.y, heaterEnabled.u);
  connect(heaterEnabled.y, heaterCommand.u);
  connect(heaterCommand.y, heaterGain.u);
  connect(heaterGain.y, heater.Q_flow);
  connect(heaterGain.y, heaterEnergy.u);

  waterTemperatureC = water.T - 273.15;
  heaterPowerW = heaterGain.y;
  heaterEnergyJ = heaterEnergy.y;
  heaterOn = heaterCommand.y;
end CoffeeMachine;
