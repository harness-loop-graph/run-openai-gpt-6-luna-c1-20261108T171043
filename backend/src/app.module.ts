import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller";
import { ApiService } from "./api.service";
import { RateLimitGuard } from "./common/rate-limit";

@Module({
  controllers: [ApiController],
  providers: [ApiService, RateLimitGuard],
})
export class AppModule {}
