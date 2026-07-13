import { Module } from "@nestjs/common";
import { ShiftsController } from "./shifts.controller";
import { ShiftCommandsService } from "./shift-commands.service";
import { SearchShiftsQuery } from "./search-shifts.query";
import { SearchShiftsByCityQuery } from "./search-shifts-by-city.query";

@Module({
  controllers: [ShiftsController],
  providers: [ShiftCommandsService, SearchShiftsQuery, SearchShiftsByCityQuery],
  exports: [ShiftCommandsService, SearchShiftsQuery, SearchShiftsByCityQuery],
})
export class ShiftsModule {}
