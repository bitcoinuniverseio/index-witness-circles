import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  AddressPaginationDto,
  CirclesQueryDto,
  FeesQueryDto,
  GraphQueryDto,
  InvalidEventsQueryDto,
  LineageHistoryQueryDto,
  LineagesQueryDto,
  MempoolQueryDto,
  SafetyOutpointsDto,
  SearchQueryDto,
  TrendingQueryDto,
  ValidateTransactionDto,
} from './query.dto';
import { WitnessQueryService } from './witness-query.service';

const PUBLIC_CACHE = 'public, max-age=10, stale-while-revalidate=30';

@ApiTags('witness')
@Controller('v1/witness')
export class WitnessController {
  constructor(private readonly queries: WitnessQueryService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Indexer, node, checkpoint, mempool, and protocol status' })
  status(): ReturnType<WitnessQueryService['status']> {
    return this.queries.status();
  }

  @Get('circles')
  @Header('Cache-Control', PUBLIC_CACHE)
  circles(@Query() query: CirclesQueryDto): ReturnType<WitnessQueryService['circles']> {
    return this.queries.circles(query);
  }

  @Get('circles/:txid')
  @Header('Cache-Control', PUBLIC_CACHE)
  circle(@Param('txid') txid: string): ReturnType<WitnessQueryService['circle']> {
    return this.queries.circle(txid);
  }

  @Get('transactions/:txid')
  @Header('Cache-Control', PUBLIC_CACHE)
  transaction(@Param('txid') txid: string): ReturnType<WitnessQueryService['transaction']> {
    return this.queries.transaction(txid);
  }

  @Get('lineages')
  @Header('Cache-Control', PUBLIC_CACHE)
  lineages(@Query() query: LineagesQueryDto): ReturnType<WitnessQueryService['lineages']> {
    return this.queries.lineages(query);
  }

  @Get('lineages/:lineageId')
  @Header('Cache-Control', PUBLIC_CACHE)
  lineage(@Param('lineageId') lineageId: string): ReturnType<WitnessQueryService['lineage']> {
    return this.queries.lineage(lineageId);
  }

  @Get('lineages/:lineageId/history')
  @Header('Cache-Control', PUBLIC_CACHE)
  lineageHistory(
    @Param('lineageId') lineageId: string,
    @Query() query: LineageHistoryQueryDto,
  ): ReturnType<WitnessQueryService['lineageHistory']> {
    return this.queries.lineageHistory(lineageId, query);
  }

  @Get('shards/:txid/:vout')
  @Header('Cache-Control', PUBLIC_CACHE)
  @ApiParam({ name: 'vout', type: Number, description: 'Nonnegative transaction output index' })
  shard(
    @Param('txid') txid: string,
    @Param('vout', ParseIntPipe) vout: number,
  ): ReturnType<WitnessQueryService['shard']> {
    return this.queries.shard(txid, vout);
  }

  @Get('addresses/:address/holdings')
  @Header('Cache-Control', PUBLIC_CACHE)
  holdings(
    @Param('address') address: string,
    @Query() query: AddressPaginationDto,
  ): ReturnType<WitnessQueryService['addressHoldings']> {
    return this.queries.addressHoldings(address, query);
  }

  @Get('addresses/:address/activity')
  @Header('Cache-Control', PUBLIC_CACHE)
  activity(
    @Param('address') address: string,
    @Query() query: AddressPaginationDto,
  ): ReturnType<WitnessQueryService['addressActivity']> {
    return this.queries.addressActivity(address, query);
  }

  @Get('graph')
  @Header('Cache-Control', PUBLIC_CACHE)
  graph(@Query() query: GraphQueryDto): ReturnType<WitnessQueryService['graph']> {
    return this.queries.graph(query);
  }

  @Get('mempool')
  @Header('Cache-Control', 'no-store')
  mempool(@Query() query: MempoolQueryDto): ReturnType<WitnessQueryService['mempool']> {
    return this.queries.mempool(query);
  }

  @Get('mempool/:txid')
  @Header('Cache-Control', 'no-store')
  mempoolTransaction(
    @Param('txid') txid: string,
  ): ReturnType<WitnessQueryService['mempoolTransaction']> {
    return this.queries.mempoolTransaction(txid);
  }

  @Get('invalid-events')
  @Header('Cache-Control', PUBLIC_CACHE)
  invalidEvents(
    @Query() query: InvalidEventsQueryDto,
  ): ReturnType<WitnessQueryService['invalidEvents']> {
    return this.queries.invalidEvents(query);
  }

  @Get('invalid-events/:txid')
  @Header('Cache-Control', PUBLIC_CACHE)
  invalidEvent(@Param('txid') txid: string): ReturnType<WitnessQueryService['invalidEvent']> {
    return this.queries.invalidEvent(txid);
  }

  @Get('search')
  @Header('Cache-Control', PUBLIC_CACHE)
  search(@Query() query: SearchQueryDto): ReturnType<WitnessQueryService['search']> {
    return this.queries.search(query);
  }

  @Get('trending')
  @Header('Cache-Control', PUBLIC_CACHE)
  trending(@Query() query: TrendingQueryDto): ReturnType<WitnessQueryService['trending']> {
    return this.queries.trending(query);
  }

  @Get('stats')
  @Header('Cache-Control', PUBLIC_CACHE)
  stats(): ReturnType<WitnessQueryService['stats']> {
    return this.queries.stats();
  }

  @Get('fees')
  @Header('Cache-Control', 'public, max-age=30')
  fees(@Query() query: FeesQueryDto): ReturnType<WitnessQueryService['fees']> {
    return this.queries.fees(query);
  }

  @Post('validate')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Decode and validate a raw transaction without mutating state' })
  validate(@Body() body: ValidateTransactionDto): ReturnType<WitnessQueryService['validate']> {
    return this.queries.validate(body.rawHex);
  }

  @Post('safety/outpoints')
  @Header('Cache-Control', 'no-store, max-age=0')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Classify exact outpoints against one stable chain and mempool view' })
  safetyOutpoints(
    @Body() body: SafetyOutpointsDto,
  ): ReturnType<WitnessQueryService['safetyOutpoints']> {
    return this.queries.safetyOutpoints(body.outpoints);
  }
}
