import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { CalendarQuery } from "./calendar.query";

@Module({
  controllers: [CalendarController],
  providers: [CalendarQuery],
  exports: [CalendarQuery],
})
export class CalendarModule {}
