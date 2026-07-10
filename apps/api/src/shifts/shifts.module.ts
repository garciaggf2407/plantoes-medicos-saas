import { Module } from "@nestjs/common";
import { ShiftsController } from "./shifts.controller";
import { ShiftCommandsService } from "./shift-commands.service";
import { SearchShiftsQuery } from "./search-shifts.query";

@Module({
  controllers: [ShiftsController],
  providers: [ShiftCommandsService, SearchShiftsQuery],
  exports: [ShiftCommandsService, SearchShiftsQuery],
})
export class ShiftsModule {}
