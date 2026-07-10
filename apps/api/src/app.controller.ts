import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";
import { Public } from "./identity/decorators/public.decorator";

@Controller("health")
@Public()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHealth(): { status: string } {
    return this.appService.getHealth();
  }
}
